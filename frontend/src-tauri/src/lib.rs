use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};

/// Apply Windows' CREATE_NO_WINDOW so spawned console programs (python, ffmpeg,
/// powershell, etc.) don't flash a black console window on each call. No-op on
/// every other platform, so macOS/Linux behaviour is unchanged.
#[cfg(target_os = "windows")]
fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000) // CREATE_NO_WINDOW
}
#[cfg(not(target_os = "windows"))]
#[inline]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

#[derive(Serialize)]
struct AudioFile {
    filename: String,
    size: u64,
    created: String,
    duration_secs: f64,
    voice_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomVoice {
    pub id: String,
    pub name: String,
    pub gender: String,
    #[serde(default)]
    pub embedding: String,
    #[serde(default)]
    pub ref_wav: String,
    #[serde(default)]
    pub ref_text: String,
    pub created: u64,
    pub engine: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve the backend directory.
/// Priority: relative paths from the executable (dev + prod), then user Documents.
fn backend_dir() -> String {
    let exe = std::env::current_exe()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    // Walk up from the executable — works for both dev and prod layouts
    for depth in [5u32, 4, 3, 2] {
        let mut p = exe.clone();
        for _ in 0..depth { p.pop(); }
        p.push("backend");
        if p.exists() { return p.to_string_lossy().to_string(); }
    }

    // User Documents fallback — checked in order:
    //   1. ~/Documents/Curzon/backend   (installed via first-launch setup wizard)
    //   2. ~/Documents/VoiceAI/backend  (legacy dev clone location)
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let curzon = std::path::PathBuf::from(&home)
        .join("Documents").join("Curzon").join("backend");
    if curzon.exists() { return curzon.to_string_lossy().to_string(); }

    let legacy = std::path::PathBuf::from(&home)
        .join("Documents").join("VoiceAI").join("backend");
    if legacy.exists() { return legacy.to_string_lossy().to_string(); }

    "../../backend".to_string()
}

/// Return the Python executable to use, preferring the venv created by the
/// setup script, then falling back to system Python candidates.
fn python_exe() -> String {
    let bd = backend_dir();

    // ── Venv installed by setup.sh / setup.ps1 (highest priority) ────────────
    let venv = if cfg!(target_os = "windows") {
        format!("{}\\venv\\Scripts\\python.exe", bd)
    } else {
        format!("{}/venv/bin/python3", bd)
    };
    if std::path::Path::new(&venv).exists() { return venv; }

    // ── Windows system Python ─────────────────────────────────────────────────
    if cfg!(target_os = "windows") {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let user  = std::env::var("USERPROFILE").unwrap_or_default();
        let candidates = vec![
            format!("{}\\Programs\\Python\\Python311\\python.exe", local),
            format!("{}\\Programs\\Python\\Python312\\python.exe", local),
            format!("{}\\AppData\\Local\\Programs\\Python\\Python311\\python.exe", user),
            "C:\\Python311\\python.exe".to_string(),
            "C:\\Python312\\python.exe".to_string(),
            "python3.exe".to_string(),
            "python.exe".to_string(),
        ];
        for c in &candidates {
            if std::path::Path::new(c.as_str()).exists()
                && no_window(&mut Command::new(c)).arg("--version").output()
                    .map(|o| o.status.success()).unwrap_or(false)
            {
                return c.clone();
            }
        }
        return "python".to_string();
    }

    // ── macOS / Linux ─────────────────────────────────────────────────────────
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = vec![
        format!("{}/.pyenv/shims/python3.11", home),
        format!("{}/.pyenv/shims/python3", home),
        "/opt/homebrew/bin/python3.11".to_string(),
        "/opt/homebrew/opt/python@3.11/bin/python3.11".to_string(),
        "/usr/local/bin/python3.11".to_string(),
        "/usr/local/opt/python@3.11/bin/python3.11".to_string(),
        "/usr/bin/python3.11".to_string(),
        "/opt/homebrew/bin/python3".to_string(),
        "/usr/local/bin/python3".to_string(),
        "/usr/bin/python3".to_string(),
    ];
    for c in &candidates {
        if std::path::Path::new(c.as_str()).exists()
            && no_window(&mut Command::new(c)).arg("--version").output()
                .map(|o| o.status.success()).unwrap_or(false)
        {
            return c.clone();
        }
    }
    "python3.11".to_string()
}

/// Build a PATH string that includes Homebrew and common system bin dirs so
/// that ffmpeg and other tools are reachable even when launched from a GUI.
fn augmented_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    if cfg!(target_os = "macos") {
        format!("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:{}", current)
    } else {
        current
    }
}

fn wav_duration(path: &str) -> f64 {
    let mut f = match fs::File::open(path) { Ok(f) => f, Err(_) => return 0.0 };
    let mut header = [0u8; 44];
    if f.read_exact(&mut header).is_err() { return 0.0; }
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" { return 0.0; }
    let byte_rate = u32::from_le_bytes([header[28], header[29], header[30], header[31]]) as f64;
    let data_size = u32::from_le_bytes([header[40], header[41], header[42], header[43]]) as f64;
    if byte_rate == 0.0 { return 0.0; }
    data_size / byte_rate
}

fn history_dir()              -> String { format!("{}/history",       backend_dir()) }
fn custom_voices_dir()        -> String { format!("{}/custom_voices", backend_dir()) }
fn custom_voices_manifest()   -> String { format!("{}/voices.json",   custom_voices_dir()) }
fn kokoro_model_dir()         -> String { format!("{}/models/kokoro", backend_dir()) }

#[tauri::command]
fn debug_paths() -> String {
    let py  = python_exe();
    let dir = backend_dir();
    let (py_ok, py_ver) = match no_window(&mut Command::new(&py)).arg("--version").output() {
        Ok(out) => {
            let v = String::from_utf8_lossy(&out.stdout).to_string()
                  + &String::from_utf8_lossy(&out.stderr);
            (v.contains("Python 3"), v.trim().to_string())
        }
        Err(e) => (false, format!("exec failed: {}", e)),
    };
    format!(
        "exe:         {}\npython:      {}\npy_version:  {}\npy_ok:       {}\nbackend_dir: {}",
        std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| "?".to_string()),
        py, py_ver, py_ok, dir
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// F5-TTS PERSISTENT WORKER
//
// Loading the ~1.2 GB F5-TTS model takes 10-15 s. Instead of paying that on
// every generation (one-shot generate.py subprocess), we keep a single resident
// f5_worker.py process with the model loaded and stream requests to it over
// stdin/stdout. Custom-voice generation then only pays for inference.
// ─────────────────────────────────────────────────────────────────────────────

struct F5Worker {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
}

#[derive(Default)]
struct F5WorkerState(Mutex<Option<F5Worker>>);

/// Spawn the worker and block until it reports `{"status":"ready"}` (model loaded).
fn spawn_f5_worker() -> Result<F5Worker, String> {
    let py = python_exe();
    let script = format!("{}/f5_worker.py", backend_dir());
    if !std::path::Path::new(&script).exists() {
        return Err(format!(
            "F5 worker script is missing ({}). This usually means an interrupted \
             update — please relaunch Curzon, or reinstall to repair the backend.",
            script
        ));
    }
    let mut child = no_window(&mut Command::new(&py))
        .arg(&script)
        .env("PATH", augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // worker diagnostics flow to the app's stderr/log
        .spawn()
        .map_err(|e| format!("Failed to start F5 worker ({}): {}", py, e))?;
    let stdin = child.stdin.take().ok_or("F5 worker has no stdin")?;
    let stdout = child.stdout.take().ok_or("F5 worker has no stdout")?;
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("F5 worker read error during startup: {}", e))?;
        if n == 0 {
            return Err("F5 worker exited before becoming ready".to_string());
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.contains("\"ready\"") {
            break;
        }
        if line.contains("\"fatal\"") {
            return Err(format!("F5 worker failed to load model: {}", line));
        }
    }
    Ok(F5Worker { child, stdin, reader })
}

/// Send one request to the worker; restart it once if the pipe is dead.
fn f5_generate(state: &Mutex<Option<F5Worker>>, request: &str) -> Result<String, String> {
    for attempt in 0..2 {
        let mut guard = state.lock().map_err(|e| format!("F5 worker lock poisoned: {}", e))?;
        if guard.is_none() {
            *guard = Some(spawn_f5_worker()?);
        }
        let worker = guard.as_mut().unwrap();

        // Write the request line.
        if writeln!(worker.stdin, "{}", request)
            .and_then(|_| worker.stdin.flush())
            .is_err()
        {
            let _ = guard.take().map(|mut w| w.child.kill());
            if attempt == 0 { continue; }
            return Err("F5 worker write failed".to_string());
        }

        // Read until we get a parseable JSON protocol line. Any stray
        // library output (tqdm, "Converting audio...", etc.) that leaks onto
        // stdout is skipped rather than treated as the response.
        let mut dead = false;
        let mut result: Option<Result<String, String>> = None;
        loop {
            let mut line = String::new();
            match worker.reader.read_line(&mut line) {
                Ok(0) => { dead = true; break; }
                Err(_) => { dead = true; break; }
                Ok(_) => {}
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue, // not protocol — ignore stray stdout noise
            };
            match v.get("status").and_then(|s| s.as_str()) {
                Some("ok") => {
                    result = Some(Ok(v.get("file").and_then(|f| f.as_str()).unwrap_or("").to_string()));
                    break;
                }
                Some("error") => {
                    result = Some(Err(v.get("message").and_then(|m| m.as_str())
                        .unwrap_or("unknown F5 error").to_string()));
                    break;
                }
                _ => continue, // e.g. a stray status we don't recognise
            }
        }

        if dead {
            let _ = guard.take().map(|mut w| w.child.kill());
            if attempt == 0 { continue; }
            return Err("F5 worker closed unexpectedly".to_string());
        }
        if let Some(r) = result {
            return r;
        }
    }
    Err("F5 worker unavailable".to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO GENERATION
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn generate_voice(
    state: tauri::State<'_, F5WorkerState>,
    text: String, voice: String, voice_engine: Option<String>,
    emotion: Option<f64>, speed: Option<f64>, pitch: Option<f64>,
    volume: Option<f64>, style_strength: Option<f64>, trim_silence: Option<bool>,
    mastering_preset: Option<String>,
) -> Result<String, String> {
    let engine = voice_engine.unwrap_or_else(|| voice.clone());

    // ── Custom voices → persistent F5-TTS worker (no per-call model reload) ──
    if engine.starts_with("f5tts|") {
        let voice_id = engine.splitn(3, '|').nth(1).unwrap_or("").to_string();
        let abs_voices_dir = std::fs::canonicalize(custom_voices_dir())
            .unwrap_or_else(|_| std::path::PathBuf::from(custom_voices_dir()));
        let req = serde_json::json!({
            "text":         text,
            "voice_id":     voice_id,
            "voices_dir":   abs_voices_dir.to_string_lossy(),
            "speed":        speed.unwrap_or(1.0),
            "pitch":        pitch.unwrap_or(0.0),
            "volume":       volume.unwrap_or(80.0),
            "trim_silence": trim_silence.unwrap_or(false),
            "mastering":    mastering_preset.unwrap_or_else(|| "none".to_string()),
        });
        return f5_generate(&state.0, &req.to_string());
    }

    // ── All other engines (Kokoro, Piper, Coqui) → one-shot generate.py ──────
    let py = python_exe();
    let output = no_window(&mut Command::new(&py))
        .arg(format!("{}/generate.py", backend_dir()))
        .arg(&text).arg(&engine)
        .arg(emotion.unwrap_or(50.0).to_string())
        .arg(speed.unwrap_or(1.0).to_string())
        .arg(pitch.unwrap_or(0.0).to_string())
        .arg(volume.unwrap_or(80.0).to_string())
        .arg(style_strength.unwrap_or(50.0).to_string())
        .arg(if trim_silence.unwrap_or(false) { "1" } else { "0" })
        .arg(mastering_preset.unwrap_or_else(|| "none".to_string()))
        .env("PATH", augmented_path())
        .output()
        .map_err(|e| format!("Failed to spawn python ({}): {}", py, e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() { Ok(stdout) }
    else {
        let mut parts: Vec<&str> = Vec::new();
        if !stderr.is_empty() { parts.push(stderr.as_str()); }
        if !stdout.is_empty() { parts.push(stdout.as_str()); }
        Err(parts.join("\n"))
    }
}

#[tauri::command]
fn enhance_script(text: String, mode: String, style: String) -> Result<String, String> {
    if text.trim().is_empty() { return Ok(text); }
    let py = python_exe();
    let output = no_window(&mut Command::new(&py))
        .arg(format!("{}/enhance.py", backend_dir()))
        .arg(&mode).arg(&style).arg(&text)
        .env("PATH", augmented_path())
        .output()
        .map_err(|e| format!("Failed to spawn enhance.py: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { text } else { stdout })
    } else {
        Err(if !stderr.is_empty() { stderr } else { format!("enhance.py exited with {}", output.status) })
    }
}

#[tauri::command]
fn stop_audio() -> Result<String, String> {
    if cfg!(target_os = "windows") {
        let _ = no_window(&mut Command::new("taskkill")).args(["/F", "/IM", "wmplayer.exe"]).output();
    } else {
        let _ = Command::new("pkill").arg("-f").arg("afplay").output();
        let _ = Command::new("pkill").arg("-f").arg("paplay").output();
    }
    Ok("Stopped".to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO FILE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_audio_bytes() -> Result<Vec<u8>, String> {
    let history_path = history_dir();
    let entries = fs::read_dir(&history_path)
        .map_err(|e| format!("Cannot read history dir '{}': {}", history_path, e))?;
    let mut latest_path  = None;
    let mut latest_mtime = 0u64;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta  = entry.metadata().map_err(|e| e.to_string())?;
        let name  = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".wav") { continue; }
        let mtime = meta.modified().unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH).unwrap().as_secs();
        if mtime >= latest_mtime { latest_mtime = mtime; latest_path = Some(entry.path()); }
    }
    let file  = latest_path.ok_or("No .wav files found in history")?;
    fs::read(&file).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_audio_file(filename: String) -> Result<Vec<u8>, String> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    let path = format!("{}/{}", history_dir(), filename);
    fs::read(&path).map_err(|e| format!("Cannot read '{}': {}", path, e))
}

#[tauri::command]
fn rename_audio_file(old_name: String, new_name: String) -> Result<String, String> {
    for n in [&old_name, &new_name] {
        if n.contains('/') || n.contains('\\') || n.contains("..") {
            return Err(format!("Invalid filename: {}", n));
        }
    }
    let old_path = format!("{}/{}", history_dir(), old_name);
    let mut final_name = new_name;
    if !final_name.to_lowercase().ends_with(".wav") { final_name.push_str(".wav"); }
    let new_path = format!("{}/{}", history_dir(), final_name);
    fs::rename(&old_path, &new_path).map_err(|e| format!("Rename failed: {}", e))?;
    Ok(final_name)
}

#[tauri::command]
fn delete_audio_file(filename: String) -> Result<String, String> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    let path = format!("{}/{}", history_dir(), filename);
    fs::remove_file(&path).map_err(|e| format!("Delete failed: {}", e))?;
    Ok("Deleted".to_string())
}

#[tauri::command]
fn get_history_details() -> Result<Vec<AudioFile>, String> {
    let history_path = history_dir();
    fs::create_dir_all(&history_path).map_err(|e| format!("Cannot create history dir: {}", e))?;
    let entries = fs::read_dir(&history_path).map_err(|e| format!("Cannot read history dir: {}", e))?;
    let mut files = Vec::<AudioFile>::new();
    for entry in entries {
        let entry    = entry.map_err(|e| e.to_string())?;
        let filename = entry.file_name().to_string_lossy().to_string();
        if !filename.to_lowercase().ends_with(".wav") { continue; }
        let metadata      = entry.metadata().map_err(|e| e.to_string())?;
        let size          = metadata.len();
        let created       = metadata.modified().unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH).unwrap().as_secs().to_string();
        let full_path     = format!("{}/{}", history_path, filename);
        let duration_secs = wav_duration(&full_path);
        let meta_path     = format!("{}/{}.meta", history_path, filename);
        let voice_name    = fs::read_to_string(&meta_path).unwrap_or_default().trim().to_string();
        files.push(AudioFile { filename, size, created, duration_secs, voice_name });
    }
    files.sort_by(|a, b| b.filename.cmp(&a.filename));
    Ok(files)
}

#[tauri::command]
fn save_audio_meta(filename: String, voice_name: String) -> Result<(), String> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    let path = format!("{}/{}.meta", history_dir(), filename);
    fs::write(&path, voice_name.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn trim_audio(filename: String, start_sec: f64, end_sec: f64) -> Result<String, String> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    let input_path = format!("{}/{}", history_dir(), filename);
    let ts = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let out_name = format!("voice_{}_trim.wav", ts);
    let out_path = format!("{}/{}", history_dir(), out_name);
    let py = python_exe();
    let output = no_window(&mut Command::new(&py))
        .arg(format!("{}/trim.py", backend_dir()))
        .arg(&input_path).arg(&out_path)
        .arg(start_sec.to_string()).arg(end_sec.to_string())
        .env("PATH", augmented_path())
        .output()
        .map_err(|e| format!("Failed to spawn trim.py: {}", e))?;
    if output.status.success() { Ok(out_name) }
    else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() { "trim.py failed".to_string() } else { stderr })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD TO NATIVE DOWNLOADS FOLDER
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn save_to_downloads(filenames: Vec<String>) -> Result<String, String> {
    // Use HOME on macOS/Linux, USERPROFILE on Windows
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| {
            if cfg!(target_os = "windows") { "C:\\Users\\Public".to_string() }
            else { "/tmp".to_string() }
        });
    let downloads = std::path::PathBuf::from(&home).join("Downloads");
    if !downloads.exists() {
        fs::create_dir_all(&downloads)
            .map_err(|e| format!("Cannot create Downloads folder: {}", e))?;
    }
    let hist = history_dir();
    let mut saved = 0usize;
    for filename in &filenames {
        if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
            return Err(format!("Invalid filename: {}", filename));
        }
        let src = format!("{}/{}", hist, filename);
        let mut dst = downloads.join(filename);
        if dst.exists() {
            let stem = filename.trim_end_matches(".wav");
            let mut n = 1u32;
            loop {
                dst = downloads.join(format!("{}({}).wav", stem, n));
                if !dst.exists() { break; }
                n += 1;
            }
        }
        fs::copy(&src, &dst)
            .map_err(|e| format!("Failed to copy '{}': {}", filename, e))?;
        saved += 1;
    }
    Ok(format!("Saved {} file(s) to ~/Downloads", saved))
}

// ─────────────────────────────────────────────────────────────────────────────
// VOICE TRAINING
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn train_voice(audio_path: String, voice_name: String, gender: String) -> Result<String, String> {
    if audio_path.contains("..") { return Err("Invalid audio path".to_string()); }
    if voice_name.trim().is_empty() { return Err("Voice name cannot be empty".to_string()); }
    let py = python_exe();
    let voices_dir = custom_voices_dir();
    fs::create_dir_all(&voices_dir).map_err(|e| format!("Cannot create custom_voices dir: {}", e))?;
    let abs_voices_dir = std::fs::canonicalize(&voices_dir)
        .unwrap_or_else(|_| std::path::PathBuf::from(&voices_dir));
    let output = no_window(&mut Command::new(&py))
        .arg(format!("{}/train_voice.py", backend_dir()))
        .arg(&audio_path).arg(&voice_name).arg(&gender)
        .arg(abs_voices_dir.to_string_lossy().as_ref())
        .env("PATH", augmented_path())
        .output()
        .map_err(|e| format!("Failed to spawn train_voice.py: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let json_line = stdout.lines()
        .filter(|l| l.trim_start().starts_with('{'))
        .last().unwrap_or("").to_string();
    if !json_line.is_empty() { Ok(json_line) }
    else if !stdout.is_empty() { Ok(stdout) }
    else { Err(format!("train_voice.py produced no output.\nstderr: {}", stderr)) }
}

#[tauri::command]
fn list_custom_voices() -> Result<Vec<CustomVoice>, String> {
    let manifest = custom_voices_manifest();
    if !std::path::Path::new(&manifest).exists() { return Ok(vec![]); }
    let raw = fs::read_to_string(&manifest).map_err(|e| format!("Cannot read voices.json: {}", e))?;
    serde_json::from_str::<Vec<CustomVoice>>(&raw).map_err(|e| format!("Malformed voices.json: {}", e))
}

#[tauri::command]
fn delete_custom_voice(voice_id: String) -> Result<String, String> {
    if voice_id.contains('/') || voice_id.contains('\\') || voice_id.contains("..") {
        return Err("Invalid voice ID".to_string());
    }
    let manifest_path = custom_voices_manifest();
    if !std::path::Path::new(&manifest_path).exists() { return Err("No custom voices found".to_string()); }
    let raw = fs::read_to_string(&manifest_path).map_err(|e| format!("Cannot read voices.json: {}", e))?;
    let mut voices: Vec<CustomVoice> = serde_json::from_str(&raw)
        .map_err(|e| format!("Malformed voices.json: {}", e))?;
    let removed = voices.iter().find(|v| v.id == voice_id).cloned()
        .ok_or_else(|| format!("Voice '{}' not found", voice_id))?;
    voices.retain(|v| v.id != voice_id);
    let updated = serde_json::to_string_pretty(&voices)
        .map_err(|e| format!("Serialisation failed: {}", e))?;
    fs::write(&manifest_path, updated)
        .map_err(|e| format!("Cannot write voices.json: {}", e))?;
    if !removed.embedding.is_empty() {
        let emb_path = format!("{}/{}", custom_voices_dir(), removed.embedding);
        if std::path::Path::new(&emb_path).exists() { let _ = fs::remove_file(&emb_path); }
    }
    if !removed.ref_wav.is_empty() {
        let ref_path = format!("{}/{}", custom_voices_dir(), removed.ref_wav);
        if std::path::Path::new(&ref_path).exists() { let _ = fs::remove_file(&ref_path); }
    }
    Ok(format!("Deleted voice '{}'", removed.name))
}

// ─────────────────────────────────────────────────────────────────────────────
// KOKORO MODEL
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn check_kokoro_downloaded() -> bool {
    let dir    = kokoro_model_dir();
    let onnx   = format!("{}/kokoro-v1.0.onnx", dir);
    let voices = format!("{}/voices-v1.0.bin",  dir);
    std::path::Path::new(&onnx).metadata().map(|m| m.len() > 10_000_000).unwrap_or(false)
        && std::path::Path::new(&voices).metadata().map(|m| m.len() > 100_000).unwrap_or(false)
}

#[tauri::command]
fn download_kokoro_model() -> Result<String, String> {
    let py     = python_exe();
    let script = format!("{}/download_kokoro.py", backend_dir());
    if !std::path::Path::new(&script).exists() {
        return Err(format!("download_kokoro.py not found at: {}", script));
    }
    let output = no_window(&mut Command::new(&py))
        .arg(&script)
        .env("PATH", augmented_path())
        .output()
        .map_err(|e| format!("Failed to spawn download_kokoro.py: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() { Ok(stdout) }
    else { Err(if !stderr.is_empty() { stderr } else { stdout }) }
}

// ─────────────────────────────────────────────────────────────────────────────
// F5-TTS CUSTOM VOICE
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn save_f5_voice(
    audio_path: String,
    voice_name: String,
    gender: String,
    ref_text: String,
) -> Result<String, String> {
    if audio_path.contains("..") { return Err("Invalid audio path".to_string()); }
    if voice_name.trim().is_empty() { return Err("Voice name cannot be empty".to_string()); }

    let voices_dir = custom_voices_dir();
    fs::create_dir_all(&voices_dir)
        .map_err(|e| format!("Cannot create custom_voices dir: {}", e))?;

    let ts       = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let voice_id = format!("f5v_{}", ts);

    let ref_filename = format!("{}_ref.wav", voice_id);
    let ref_dest     = format!("{}/{}", voices_dir, ref_filename);

    // Prefer ffmpeg for clean conversion; fall back to plain file copy
    let ff_out = no_window(&mut Command::new("ffmpeg"))
        .args(["-y", "-i", &audio_path, "-t", "10",
               "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", &ref_dest])
        .env("PATH", augmented_path())
        .output();
    match ff_out {
        Ok(o) if o.status.success() => {}
        _ => {
            fs::copy(&audio_path, &ref_dest)
                .map_err(|e| format!("Cannot copy reference audio: {}", e))?;
        }
    }

    let manifest_path = custom_voices_manifest();
    let mut voices: Vec<CustomVoice> = if std::path::Path::new(&manifest_path).exists() {
        let raw = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Cannot read voices.json: {}", e))?;
        serde_json::from_str(&raw).unwrap_or_default()
    } else { vec![] };

    let _ = ref_text;
    let clean_name = voice_name.trim().to_string();
    voices.push(CustomVoice {
        id: voice_id.clone(), name: clean_name.clone(), gender,
        embedding: String::new(), ref_wav: ref_filename, ref_text: String::new(),
        created: ts, engine: format!("f5tts|{}", voice_id),
    });

    let updated = serde_json::to_string_pretty(&voices)
        .map_err(|e| format!("Serialisation failed: {}", e))?;
    fs::write(&manifest_path, updated)
        .map_err(|e| format!("Cannot write voices.json: {}", e))?;

    Ok(format!(r#"{{"status":"ok","id":"{}","name":"{}"}}"#,
        voice_id, clean_name.replace('"', "\\\"")))
}

// ─────────────────────────────────────────────────────────────────────────────
// LICENSE VERIFICATION
// Update GUMROAD_PERMALINK to match your Gumroad product URL
// e.g. gumroad.com/l/curzon-voiceai → "curzon-voiceai"
// ─────────────────────────────────────────────────────────────────────────────

const GUMROAD_PERMALINK: &str = "curzon-voiceai";

fn djb2(s: &str) -> String {
    let mut h: u64 = 5381;
    for b in s.bytes() { h = h.wrapping_mul(33).wrapping_add(b as u64); }
    format!("{:016x}", h)
}

fn license_path() -> std::path::PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    std::path::PathBuf::from(home).join("Documents").join("Curzon").join("license.json")
}

#[tauri::command]
#[allow(unreachable_code)]
fn check_license() -> bool {
    // ─── TEMP: license gate DISABLED for end-to-end testing ──────────────────
    // Remove the `return true;` line below to RE-ENABLE before release.
    return true;
    match fs::read_to_string(license_path()) {
        Ok(s) => s.contains("\"activated\":true"),
        Err(_) => false,
    }
}

#[tauri::command]
fn activate_license(key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("Please enter your license key.".to_string());
    }

    // URL-encode the key for the POST body
    let encoded: String = key.chars().map(|c| {
        if c.is_alphanumeric() || c == '-' { c.to_string() }
        else { format!("%{:02X}", c as u32) }
    }).collect();

    let post_data = format!(
        "product_permalink={}&license_key={}&increment_uses_count=true",
        GUMROAD_PERMALINK, encoded
    );

    let curl = if cfg!(target_os = "windows") { "curl.exe" } else { "curl" };
    let out = no_window(&mut Command::new(curl))
        .args(["-s", "--max-time", "15", "-X", "POST",
               "https://api.gumroad.com/v2/licenses/verify",
               "-d", &post_data])
        .output()
        .map_err(|_| "Cannot reach the license server. Check your internet connection.".to_string())?;

    let body = String::from_utf8_lossy(&out.stdout);

    if !body.contains("\"success\":true") && !body.contains("\"success\": true") {
        let msg = body.split("\"message\"")
            .nth(1)
            .and_then(|s| s.splitn(3, '"').nth(2))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Invalid license key. Please check and try again.".to_string());
        return Err(msg);
    }

    let path = license_path();
    fs::create_dir_all(path.parent().unwrap())
        .map_err(|e| format!("Cannot save license: {}", e))?;

    let ts = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let json = format!(
        r#"{{"activated":true,"key_hash":"{}","activated_at":{}}}"#,
        djb2(&key), ts
    );
    fs::write(&path, json).map_err(|e| format!("Cannot save license: {}", e))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// APP ENTRY
// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ─────────────────────────────────────────────────────────────────────────────
// First-launch setup
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn check_setup_complete() -> bool {
    let bd = backend_dir();
    let venv = if cfg!(target_os = "windows") {
        format!("{}\\venv\\Scripts\\python.exe", bd)
    } else {
        format!("{}/venv/bin/python3", bd)
    };
    if !std::path::Path::new(&venv).exists() { return false; }
    // Confirm at least the Kokoro model was downloaded
    let kokoro = format!("{}/models/kokoro/kokoro-v1.0.onnx", bd);
    std::path::Path::new(&kokoro).exists()
}

#[tauri::command]
fn run_setup(app: tauri::AppHandle) -> Result<(), String> {
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("resource_dir: {}", e))?;

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let backend_target = std::path::PathBuf::from(&home)
        .join("Documents").join("Curzon").join("backend");
    std::fs::create_dir_all(&backend_target)
        .map_err(|e| format!("mkdir: {}", e))?;

    let backend_str  = backend_target.to_string_lossy().to_string();
    let resource_str = resource_dir.to_string_lossy().to_string();

    // Capture the full setup transcript to a file so first-run failures are
    // diagnosable (the UI only shows a generic exit code).
    let log_path = std::path::PathBuf::from(&home)
        .join("Documents").join("Curzon").join("setup.log");

    let (interpreter, script_args): (String, Vec<String>) = if cfg!(target_os = "windows") {
        let s = resource_dir.join("scripts").join("setup.ps1").to_string_lossy().to_string();
        ("powershell.exe".into(), vec!["-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-File".into(), s])
    } else {
        let s = resource_dir.join("scripts").join("setup.sh").to_string_lossy().to_string();
        let _ = Command::new("chmod").args(["+x", &s]).status();
        ("bash".into(), vec![s])
    };

    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut cmd = Command::new(&interpreter);
        no_window(&mut cmd); // suppress the console window on Windows
        for a in &script_args { cmd.arg(a); }
        cmd.env("CURZON_BACKEND_DIR",    &backend_str);
        cmd.env("CURZON_RESOURCE_DIR",   &resource_str);
        cmd.env("CURZON_NON_INTERACTIVE", "1");
        cmd.env("PATH", augmented_path());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => { let _ = app_clone.emit("setup-error", format!("Cannot start setup: {}", e)); return; }
        };

        // Shared, line-buffered handle to setup.log written by both reader threads.
        let log = std::sync::Arc::new(std::sync::Mutex::new(std::fs::File::create(&log_path).ok()));

        if let Some(out) = child.stdout.take() {
            let a = app_clone.clone();
            let log = log.clone();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(out).lines().flatten() {
                    let _ = a.emit("setup-log", &line);
                    if let Ok(mut g) = log.lock() {
                        if let Some(f) = g.as_mut() { let _ = writeln!(f, "{}", line); }
                    }
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            let a = app_clone.clone();
            let log = log.clone();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(err).lines().flatten() {
                    let _ = a.emit("setup-log", &line);
                    if let Ok(mut g) = log.lock() {
                        if let Some(f) = g.as_mut() { let _ = writeln!(f, "{}", line); }
                    }
                }
            });
        }

        match child.wait() {
            Ok(s) if s.success() => { let _ = app_clone.emit("setup-done", ()); }
            Ok(s) => { let _ = app_clone.emit("setup-error", format!("Setup exited with code {:?}", s.code())); }
            Err(e) => { let _ = app_clone.emit("setup-error", format!("Setup error: {}", e)); }
        }
    });

    Ok(())
}

/// Keep the installed backend's Python scripts in sync with the bundled app.
///
/// Setup only runs on first install, so upgrading the app would otherwise leave
/// stale `*.py` (e.g. a new f5_worker.py would never be copied). These scripts
/// are tiny, so we refresh them from the bundle on every launch. Heavyweight
/// assets (venv, models) are untouched — only code is synced.
fn sync_backend_scripts(app: &tauri::AppHandle) {
    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let src = resource_dir.join("backend");
    if !src.exists() {
        return;
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let dst = std::path::PathBuf::from(&home)
        .join("Documents").join("Curzon").join("backend");
    // Only sync into an already-installed backend; fresh installs are handled
    // by setup.sh / setup.ps1.
    if !dst.exists() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(&src) {
        for e in entries.flatten() {
            let name = e.file_name();
            if name.to_string_lossy().ends_with(".py") {
                let _ = std::fs::copy(e.path(), dst.join(&name));
            }
        }
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(F5WorkerState::default())
        .setup(|app| {
            sync_backend_scripts(app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            debug_paths,
            generate_voice,
            enhance_script,
            stop_audio,
            get_audio_bytes,
            get_audio_file,
            save_to_downloads,
            rename_audio_file,
            delete_audio_file,
            get_history_details,
            save_audio_meta,
            trim_audio,
            train_voice,
            save_f5_voice,
            list_custom_voices,
            delete_custom_voice,
            check_kokoro_downloaded,
            download_kokoro_model,
            check_setup_complete,
            run_setup,
            check_license,
            activate_license,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Tear down the resident F5-TTS worker when the app quits so we don't
        // leave an orphaned Python process holding the model in memory.
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<F5WorkerState>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut w) = guard.take() {
                        let _ = w.child.kill();
                    }
                }
            }
        }
    });
}
