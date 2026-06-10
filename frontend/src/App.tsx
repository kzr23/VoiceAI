import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import WaveSurfer from "wavesurfer.js";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// ── Types ─────────────────────────────────────────────────────────────────────
type AudioFile = { filename: string; size: number; created: string; duration_secs: number; voice_name: string };
type SortBy = "newest"|"oldest"|"longest"|"shortest"|"largest";
type CustomVoice = { id: string; name: string; gender: "Female"|"Male"; embedding: string; created: number; engine: string };
type VoiceStyle = "none"|"news_anchor"|"narrator"|"storyteller"|"podcast_host"|"documentary";
type EnhanceMode = "none"|"punctuation"|"style"|"both";
type BrightnessMode = "darker"|"dark"|"normal"|"light"|"lighter";
type Tone = "Deep"|"Warm"|"Clear"|"Bright"|"Custom";
type VoiceEntry = { id: string; name: string; gender: "Female"|"Male"; tone: Tone; engine: string; isCustom?: boolean; category?: "Kokoro"|"Custom"; lang?: string };

// ── Download progress event from Rust ─────────────────────────────────────────
type DownloadProgress = {
  status: "checking"|"waiting"|"already_downloaded"|"downloading"|"done"|"error";
  file?: string;
  percent?: number;
  file_pct?: number;
  mb_done?: number;
  mb_total?: number;
  message?: string;
};

// ── Setup progress parser ─────────────────────────────────────────────────────
function parseSetupProgress(log: string[]) {
  let step = 0, total = 8, stepName = "";
  let lastLine = "";
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i].match(/(\d+)\/(\d+)[^·]*·\s*([^━\n]+)/);
    if (m && !stepName) { step = parseInt(m[1]); total = parseInt(m[2]); stepName = m[3].trim(); }
    const l = log[i].trim();
    if (!lastLine && l && !l.includes("━━━") && !l.includes("───") && !l.includes("first-time setup")) lastLine = l.slice(0, 72);
    if (step && lastLine) break;
  }
  const pct = step > 0 ? Math.min(Math.round(((step - 0.5) / total) * 100), 95) : 0;
  return { step, total, stepName, lastLine, pct };
}

// ── Formatters ────────────────────────────────────────────────────────────────
const formatDuration = (s: number) => { if (!s||s<=0) return "00:00"; return `${Math.floor(s/60).toString().padStart(2,"0")}:${Math.floor(s%60).toString().padStart(2,"0")}`; };
const formatSize = (b: number) => b>=1_048_576 ? (b/1_048_576).toFixed(1)+" MB" : (b/1024).toFixed(1)+" KB";
const formatCreated = (u: number) => new Date(u*1000).toLocaleDateString("en-US",{month:"short",day:"numeric"});

const PAGE_SIZE = 7;
const waveHeights = (filename: string, count = 48): number[] => {
  let h = 5381;
  for (let i = 0; i < filename.length; i++) h = ((h << 5) + h) + filename.charCodeAt(i);
  return Array.from({length: count}, (_, i) => {
    h = ((h << 5) + h) + i;
    const raw = 4 + Math.abs(h % 34);
    const x = (i / (count - 1)) * 2 - 1;
    const envelope = 0.35 + 0.65 * (1 - x * x * 0.7);
    return Math.max(3, Math.round(raw * envelope));
  });
};



// ── Brightness themes ─────────────────────────────────────────────────────────
const BRIGHTNESS: Record<BrightnessMode,{ bg:string; panel:string; panelBorder:string; input:string; cardBg:string; cardBgAlt:string; label:string }> = {
  darker:  { bg:"#03050a", panel:"#080f1c", panelBorder:"rgba(255,255,255,0.08)", input:"#060d18", cardBg:"#0d1626", cardBgAlt:"#0b1322", label:"Darkest" },
  dark:    { bg:"#060810", panel:"#0e1828", panelBorder:"rgba(255,255,255,0.09)", input:"#0c1524", cardBg:"#14203a", cardBgAlt:"#111c32", label:"Dark" },
  normal:  { bg:"#0e1830", panel:"#162e56", panelBorder:"rgba(255,255,255,0.09)", input:"#122040", cardBg:"#1a3060", cardBgAlt:"#1c3058", label:"Normal" },
  light:   { bg:"#152036", panel:"#213970", panelBorder:"rgba(255,255,255,0.10)", input:"#1c3264", cardBg:"#243e78", cardBgAlt:"#263e74", label:"Light" },
  lighter: { bg:"#1a2c4e", panel:"#2c4b90", panelBorder:"rgba(255,255,255,0.11)", input:"#263f80", cardBg:"#2e508a", cardBgAlt:"#304e98", label:"Lighter" },
};

// ── Voice styles ──────────────────────────────────────────────────────────────
const VOICE_STYLES: {id:VoiceStyle;label:string;icon:string;desc:string}[] = [
  {id:"none",         label:"None",        icon:"ti-minus",       desc:"No style applied"},
  {id:"news_anchor",  label:"News Anchor", icon:"ti-news",         desc:"Clear, authoritative"},
  {id:"narrator",     label:"Narrator",    icon:"ti-book",         desc:"Warm, flowing"},
  {id:"storyteller",  label:"Storyteller", icon:"ti-flame",        desc:"Vivid, suspenseful"},
  {id:"podcast_host", label:"Podcast Host",icon:"ti-microphone-2", desc:"Relaxed, casual"},
  {id:"documentary",  label:"Documentary", icon:"ti-world",        desc:"Cinematic gravitas"},
];

// ── Timing helper (module-level so React Compiler doesn't flag as impure-in-render) ──
const now = () => performance.now();

// ── CSSSlider — uses the new design system CSS classes ────────────────────────
const CSSSlider = ({label,icon,value,setValue,min,max,step,fmt}:{
  label:string;icon:string;value:number;setValue:(n:number)=>void;
  min:number;max:number;step:number;fmt:(v:number)=>string;
}) => {
  const pct = ((value-min)/(max-min))*100;
  return (
    <div className="slr">
      <div className="slr-hd">
        <span className="slr-lbl"><i className={`ti ${icon}`}/>{label}</span>
        <span className="slr-val">{fmt(value)}</span>
      </div>
      <div className="slr-track-wrap">
        <div className="trk">
          <div className="trk-fill" style={{width:`${pct}%`}}/>
          <div className="trk-knob" style={{left:`${pct}%`}}/>
        </div>
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={e=>setValue(Number(e.target.value))}
          style={{position:"absolute",width:"100%",opacity:0,height:"100%",cursor:"pointer",margin:0,zIndex:1}}/>
      </div>
    </div>
  );
};

// ── TrimField — local string state so the user can clear and retype freely ────
const TrimField = ({label,value,setValue,min,max}:{
  label:string;value:number;setValue:(n:number)=>void;min:number;max:number;
}) => {
  const [raw,setRaw]         = useState(String(value));
  const [prev,setPrev]       = useState(value);
  if(prev!==value){ setPrev(value); setRaw(String(value)); }
  return (
    <div className="trim-f">
      <span className="trim-fl">{label}</span>
      <input className="trim-fi" type="number" value={raw} min={min} max={max}
        onChange={e=>{
          setRaw(e.target.value);
          const n=parseInt(e.target.value,10);
          if(!isNaN(n)&&n>=min&&n<=max) setValue(n);
        }}
        onBlur={()=>{
          const n=parseInt(raw,10);
          const clamped=isNaN(n)?value:Math.max(min,Math.min(max,n));
          setRaw(String(clamped));
          setValue(clamped);
        }}/>
    </div>
  );
};

// ── Voice builders ────────────────────────────────────────────────────────────
const VCTK = (id:string,name:string,gender:"Female"|"Male",tone:Tone):VoiceEntry=>({
  id:`vctk_${id}`,name,gender,tone,engine:`tts_models/en/vctk/vits|${id}`
});
const KOKORO = (id:string,name:string,gender:"Female"|"Male",tone:Tone,lang:string):VoiceEntry=>({
  id:`kokoro_${id}`,name,gender,tone,engine:`kokoro|${id}|${lang}`,category:"Kokoro",lang,
});
const PIPER = (modelId:string,name:string,gender:"Female"|"Male",tone:Tone,lang:string):VoiceEntry=>({
  id:`piper_${modelId}`,name,gender,tone,engine:`piper|${modelId}`,category:"Kokoro",lang,
});

const KOKORO_LANG_INFO: Record<string,{flag:string;label:string}> = {
  "en-us":{flag:"🇺🇸",label:"American"},
  "en-gb":{flag:"🇬🇧",label:"British"},
  "ja":   {flag:"🇯🇵",label:"Japanese"},
  "zh":   {flag:"🇨🇳",label:"Chinese"},
  "de":   {flag:"🇩🇪",label:"German"},
  "es":   {flag:"🇪🇸",label:"Spanish"},
  "fr-fr":{flag:"🇫🇷",label:"French"},
  "hi":   {flag:"🇮🇳",label:"Hindi"},
  "it":   {flag:"🇮🇹",label:"Italian"},
  "pt":   {flag:"🇵🇹",label:"Portuguese"},
};
const KOKORO_LANGS = ["en-us","en-gb","ja","zh","de","es","fr-fr","hi","it","pt"] as const;

// ── Tone color system ──────────────────────────────────────────────────────────
const TONE_CONFIG: Record<string,{avatarBg:string;badge:string;badgeBg:string;stripe:string;glow:string;cardBg:string;cardBgSel:string}> = {
  Deep:   { avatarBg:"linear-gradient(135deg,#1e1b4b,#3730a3)", badge:"#818cf8", badgeBg:"rgba(129,140,248,0.18)", stripe:"#4f46e5", glow:"rgba(79,70,229,0.3)",   cardBg:"rgba(30,27,75,0.75)",  cardBgSel:"rgba(55,48,163,0.65)"  },
  Warm:   { avatarBg:"linear-gradient(135deg,#431407,#9a3412)", badge:"#fb923c", badgeBg:"rgba(251,146,60,0.18)",  stripe:"#ea580c", glow:"rgba(234,88,12,0.3)",   cardBg:"rgba(67,20,7,0.75)",   cardBgSel:"rgba(154,52,18,0.65)"  },
  Clear:  { avatarBg:"linear-gradient(135deg,#082f49,#0c4a6e)", badge:"#38bdf8", badgeBg:"rgba(56,189,248,0.18)",  stripe:"#0284c7", glow:"rgba(2,132,199,0.3)",   cardBg:"rgba(8,47,73,0.75)",   cardBgSel:"rgba(12,74,110,0.65)"  },
  Bright: { avatarBg:"linear-gradient(135deg,#052e16,#166534)", badge:"#4ade80", badgeBg:"rgba(74,222,128,0.18)",  stripe:"#16a34a", glow:"rgba(22,163,74,0.3)",   cardBg:"rgba(5,46,22,0.75)",   cardBgSel:"rgba(22,101,52,0.65)"  },
  Custom: { avatarBg:"linear-gradient(135deg,#2e1065,#581c87)", badge:"#c084fc", badgeBg:"rgba(192,132,252,0.18)", stripe:"#9333ea", glow:"rgba(147,51,234,0.3)",  cardBg:"rgba(46,16,101,0.75)", cardBgSel:"rgba(88,28,135,0.65)"  },
};

// ── Training steps (F5-TTS: zero-shot, no training needed) ────────────────────
const TRAIN_STEPS = [
  {icon:"📂",label:"Validating reference audio…"},
  {icon:"💾",label:"Saving voice profile…"},
];

// ── Built-in voices ───────────────────────────────────────────────────────────
const BUILT_IN_VOICES: VoiceEntry[] = [
  // ── Kokoro Premium — American English (20) ────────────────────────────────
  KOKORO("af_heart","Heart","Female","Warm","en-us"),
  KOKORO("af_bella","Bella","Female","Bright","en-us"),
  KOKORO("af_sarah","Sarah","Female","Clear","en-us"),
  KOKORO("af_alloy","Alloy","Female","Clear","en-us"),
  KOKORO("af_aoede","Aoede","Female","Warm","en-us"),
  KOKORO("af_jessica","Jessica","Female","Bright","en-us"),
  KOKORO("af_kore","Kore","Female","Deep","en-us"),
  KOKORO("af_nicole","Nicole","Female","Clear","en-us"),
  KOKORO("af_nova","Nova","Female","Warm","en-us"),
  KOKORO("af_river","River","Female","Clear","en-us"),
  KOKORO("af_sky","Sky","Female","Bright","en-us"),
  KOKORO("am_adam","Adam","Male","Warm","en-us"),
  KOKORO("am_echo","Echo","Male","Clear","en-us"),
  KOKORO("am_eric","Eric","Male","Deep","en-us"),
  KOKORO("am_fenrir","Fenrir","Male","Deep","en-us"),
  KOKORO("am_liam","Liam","Male","Warm","en-us"),
  KOKORO("am_michael","Michael","Male","Clear","en-us"),
  KOKORO("am_onyx","Onyx","Male","Deep","en-us"),
  KOKORO("am_puck","Puck","Male","Bright","en-us"),
  KOKORO("am_santa","Santa","Male","Warm","en-us"),
  // ── Kokoro Premium — British English (8) ─────────────────────────────────
  KOKORO("bf_alice","Alice","Female","Clear","en-gb"),
  KOKORO("bf_emma","Emma","Female","Warm","en-gb"),
  KOKORO("bf_isabella","Isabella","Female","Bright","en-gb"),
  KOKORO("bf_lily","Lily","Female","Clear","en-gb"),
  KOKORO("bm_daniel","Daniel","Male","Deep","en-gb"),
  KOKORO("bm_fable","Fable","Male","Warm","en-gb"),
  KOKORO("bm_george","George","Male","Clear","en-gb"),
  KOKORO("bm_lewis","Lewis","Male","Deep","en-gb"),
  // ── Kokoro Premium — Japanese (5) ────────────────────────────────────────
  KOKORO("jf_alpha","Alpha","Female","Clear","ja"),
  KOKORO("jf_gongitsune","Gongitsune","Female","Warm","ja"),
  KOKORO("jf_nezumi","Nezumi","Female","Bright","ja"),
  KOKORO("jf_tebukuro","Tebukuro","Female","Clear","ja"),
  KOKORO("jm_kumo","Kumo","Male","Warm","ja"),
  // ── Kokoro Premium — Chinese (8) ─────────────────────────────────────────
  KOKORO("zf_xiaobei","Xiaobei","Female","Bright","zh"),
  KOKORO("zf_xiaoni","Xiaoni","Female","Clear","zh"),
  KOKORO("zf_xiaoxiao","Xiaoxiao","Female","Warm","zh"),
  KOKORO("zf_xiaoyi","Xiaoyi","Female","Bright","zh"),
  KOKORO("zm_yunjian","Yunjian","Male","Deep","zh"),
  KOKORO("zm_yunxi","Yunxi","Male","Warm","zh"),
  KOKORO("zm_yunxia","Yunxia","Male","Clear","zh"),
  KOKORO("zm_yunyang","Yunyang","Male","Deep","zh"),
  // ── Kokoro Premium — Spanish (3) ────────────────────────────────────────
  KOKORO("ef_dora","Dora","Female","Warm","es"),
  KOKORO("em_alex","Alejandro","Male","Clear","es"),
  KOKORO("em_santa","Santa","Male","Warm","es"),
  // ── Kokoro Premium — French (1) ──────────────────────────────────────────
  KOKORO("ff_siwis","Siwis","Female","Warm","fr-fr"),
  // ── Kokoro Premium — Hindi (4) ───────────────────────────────────────────
  KOKORO("hf_alpha","Alpha","Female","Clear","hi"),
  KOKORO("hf_beta","Beta","Female","Bright","hi"),
  KOKORO("hm_omega","Omega","Male","Deep","hi"),
  KOKORO("hm_psi","Psi","Male","Warm","hi"),
  // ── Kokoro Premium — Italian (2) ─────────────────────────────────────────
  KOKORO("if_sara","Sara","Female","Clear","it"),
  KOKORO("im_nicola","Nicola","Male","Warm","it"),
  // ── Kokoro Premium — Portuguese (3) ──────────────────────────────────────
  KOKORO("pf_dora","Dora","Female","Warm","pt"),
  KOKORO("pm_alex","Alex","Male","Clear","pt"),
  KOKORO("pm_santa","Santa","Male","Warm","pt"),
  // ── Piper — German (2) ───────────────────────────────────────────────────────
  PIPER("de_DE-thorsten-high","Thorsten","Male","Deep","de"),
  PIPER("de_DE-kerstin-low","Kerstin","Female","Clear","de"),
  // ── Classic — LJSpeech ───────────────────────────────────────────────────
  {id:"ljspeech_tacotron2",name:"Linda",gender:"Female",tone:"Clear",engine:"tts_models/en/ljspeech/tacotron2-DDC"},
  {id:"ljspeech_glow",name:"Glow",gender:"Female",tone:"Clear",engine:"tts_models/en/ljspeech/glow-tts"},
  // ── Classic — VCTK (96 voices) ───────────────────────────────────────────
  VCTK("p333","Morgan","Female","Warm"),
  VCTK("p334","Savannah","Female","Clear"),
  VCTK("p335","Madison","Female","Bright"),
  VCTK("p336","Brooke","Female","Clear"),
  VCTK("p339","Aria","Female","Clear"),
  VCTK("p340","Elijah","Male","Warm"),
  VCTK("p341","Naomi","Female","Bright"),
  VCTK("p343","Taylor","Female","Bright"),
  VCTK("p345","Zoey","Female","Bright"),
  VCTK("p347","Piper","Female","Bright"),
  VCTK("p351","Nora","Female","Warm"),
  VCTK("p360","Alexis","Female","Clear"),
  VCTK("p361","Stella","Female","Clear"),
  VCTK("p362","Emily","Female","Warm"),
  VCTK("p363","Luna","Female","Bright"),
  VCTK("p364","Riley","Female","Bright"),
  VCTK("p374","Hazel","Female","Warm"),
  VCTK("p376","Jasper","Male","Warm"),
  VCTK("p225","Sophie","Female","Clear"),
  VCTK("p226","Dylan","Male","Warm"),
  VCTK("p227","Diana","Female","Warm"),
  VCTK("p228","Adrian","Male","Warm"),
  VCTK("p229","Patrick","Male","Warm"),
  VCTK("p230","Travis","Male","Warm"),
  VCTK("p231","Leonard","Male","Warm"),
  VCTK("p232","Oliver","Male","Warm"),
  VCTK("p233","Vincent","Male","Warm"),
  VCTK("p234","James","Male","Warm"),
  VCTK("p236","Warren","Male","Warm"),
  VCTK("p237","Penelope","Female","Clear"),
  VCTK("p238","Douglas","Male","Warm"),
  VCTK("p239","Tom","Male","Clear"),
  VCTK("p240","Zoe","Female","Clear"),
  VCTK("p241","Harvey","Male","Deep"),
  VCTK("p243","Grace","Female","Bright"),
  VCTK("p244","Cordelia","Female","Clear"),
  VCTK("p245","Ellie","Female","Clear"),
  VCTK("p246","Rowena","Female","Clear"),
  VCTK("p247","Gerald","Male","Clear"),
  VCTK("p248","Miriam","Female","Bright"),
  VCTK("p249","Niamh","Female","Warm"),
  VCTK("p250","Prudence","Female","Clear"),
  VCTK("p251","Marcus","Male","Warm"),
  VCTK("p252","Callum","Male","Warm"),
  VCTK("p253","Philip","Male","Warm"),
  VCTK("p254","Jack","Male","Deep"),
  VCTK("p256","Colin","Male","Warm"),
  VCTK("p257","Barry","Male","Clear"),
  VCTK("p258","Noah","Male","Warm"),
  VCTK("p259","Beth","Female","Bright"),
  VCTK("p260","Anthea","Female","Bright"),
  VCTK("p261","Isabelle","Female","Clear"),
  VCTK("p262","Freddie","Male","Deep"),
  VCTK("p263","Poppy","Female","Clear"),
  VCTK("p267","Wilfred","Male","Deep"),
  VCTK("p268","Beatrice","Female","Clear"),
  VCTK("p269","Bertram","Male","Warm"),
  VCTK("p270","Daphne","Female","Bright"),
  VCTK("p271","Reginald","Male","Clear"),
  VCTK("p272","Max","Male","Deep"),
  VCTK("p273","Florence","Female","Clear"),
  VCTK("p274","Victoria","Female","Clear"),
  VCTK("p275","Harriet","Female","Clear"),
  VCTK("p276","Cecilia","Female","Warm"),
  VCTK("p277","Elsie","Female","Clear"),
  VCTK("p278","Beatrix","Female","Warm"),
  VCTK("p280","Rosalind","Female","Bright"),
  VCTK("p282","Finley","Male","Clear"),
  VCTK("p283","Esme","Female","Clear"),
  VCTK("p284","Lavinia","Female","Warm"),
  VCTK("p285","Geoffrey","Male","Deep"),
  VCTK("p287","Bernard","Male","Deep"),
  VCTK("p288","Josephine","Female","Clear"),
  VCTK("p292","Alistair","Male","Clear"),
  VCTK("p293","Audrey","Female","Clear"),
  VCTK("p294","Faye","Female","Warm"),
  VCTK("p295","Iris","Female","Clear"),
  VCTK("p297","Abigail","Female","Warm"),
  VCTK("p300","Helen","Female","Bright"),
  VCTK("p303","Caitlin","Female","Clear"),
  VCTK("p304","Gwendolyn","Female","Clear"),
  VCTK("p305","Shannon","Female","Bright"),
  VCTK("p306","Sylvia","Female","Warm"),
  VCTK("p307","Nigel","Male","Warm"),
  VCTK("p308","Octavia","Female","Bright"),
  VCTK("p310","Kayleigh","Female","Clear"),
  VCTK("p314","Jade","Female","Clear"),
  VCTK("p316","Amber","Female","Clear"),
  VCTK("p317","Kieran","Male","Warm"),
  VCTK("p318","Declan","Male","Warm"),
  VCTK("p323","Fiona","Female","Clear"),
  VCTK("p326","Hamish","Male","Warm"),
  VCTK("p329","Aoife","Female","Clear"),
  VCTK("p330","Ciarán","Male","Deep"),
  VCTK("p311","Sinéad","Female","Warm"),
  VCTK("p312","Seamus","Male","Warm"),
];

const TONE_ORDER: Tone[] = ["Custom","Deep","Warm","Clear","Bright"];


// ── DownloadScreen ────────────────────────────────────────────────────────────
function DownloadScreen({ progress, error }: { progress: DownloadProgress|null; error: string; debugInfo: string }) {
  const percent = progress?.percent ?? 0;
  const mbDone  = progress?.mb_done  ?? 0;
  const mbTotal = progress?.mb_total ?? 703;
  const file    = progress?.file ?? "";

  return (
    <div style={{ backgroundColor:"#070c17", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", color:"white", WebkitFontSmoothing:"antialiased" }}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ width:"420px", textAlign:"center" }}>
        <div style={{ fontSize:"42px", fontWeight:800, letterSpacing:"-1px", marginBottom:"6px", background:"linear-gradient(135deg,#f0f4ff,#a78bfa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>Curzon VoiceAI</div>
        <div style={{ fontSize:"10px", color:"#3a4d66", textTransform:"uppercase", letterSpacing:"0.15em", marginBottom:"48px" }}>AI Voice Studio</div>

        <div style={{ background:"linear-gradient(180deg,#131e30 0%,#0e1826 100%)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:"20px", padding:"36px 40px", boxShadow:"0 12px 40px rgba(0,0,0,0.5)" }}>
          {error ? (
            <>
              <div style={{ fontSize:"15px", fontWeight:600, color:"#f87171", marginBottom:"16px" }}>Setup Failed</div>
              <div style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", borderRadius:"12px", padding:"16px", color:"#f87171", fontSize:"13px", lineHeight:1.6 }}>
                {error}<br/><br/>
                <span style={{ color:"#3a4d66" }}>Check your internet connection and restart the app.</span>
              </div>
            </>
          ) : (
            <>
              <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"24px", color:"#a78bfa", fontSize:"13px", fontWeight:500 }}>
                <span style={{ display:"inline-block", animation:"spin 1.4s linear infinite", flexShrink:0 }}>⟳</span>
                <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {file ? `Downloading ${file}…` : progress?.status === "checking" ? "Checking files…" : "Preparing…"}
                </span>
              </div>

              <div style={{ height:"6px", background:"rgba(255,255,255,0.05)", borderRadius:"3px", overflow:"hidden", marginBottom:"8px" }}>
                <div style={{ height:"100%", width:`${percent}%`, background:"linear-gradient(90deg,#4f46e5,#6366f1)", borderRadius:"3px", transition:"width 0.4s ease" }}/>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:"11px" }}>
                <span style={{ color:"#3a4d66" }}>{mbDone.toFixed(0)} MB / {mbTotal.toFixed(0)} MB</span>
                <span style={{ color:"#6366f1", fontWeight:600 }}>{percent}%</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function App() {
  // ── Model download state ─────────────────────────────────────────────────────
  const [modelReady, setModelReady]         = useState<boolean|null>(null); // null=checking
  const [debugInfo, setDebugInfo]           = useState("");
  const [dlProgress, setDlProgress]         = useState<DownloadProgress|null>(null);
  const [dlError, setDlError]               = useState("");

  // ── Core state ──────────────────────────────────────────────────────────────
  const [text, setText]                     = useState("");
  const [voice, setVoice]                   = useState("ljspeech_tacotron2");
  const [status, setStatus]                 = useState("Ready");
  const [generationTime, setGenerationTime] = useState("");
  const [audioFiles, setAudioFiles]         = useState<AudioFile[]>([]);
  const [selectedFile, setSelectedFile]     = useState("");
  const [playingFile, setPlayingFile]       = useState<string|null>(null);
  const [, setCardPlayTime]                 = useState(0);
  const [search, setSearch]                 = useState("");
  const [sortBy, setSortBy]                 = useState<SortBy>("newest");

  // ── Main player tracking ────────────────────────────────────────────────────
  const [mainIsPlaying, setMainIsPlaying]   = useState(false);
  const [mainCurrentTime, setMainCurrentTime] = useState(0);
  const [mainDuration, setMainDuration]     = useState(0);
  const [mainFileName, setMainFileName]     = useState("");

  // ── Trim ────────────────────────────────────────────────────────────────────
  const [trimStart, setTrimStart]           = useState(0);
  const [trimEnd, setTrimEnd]               = useState(0);
  const [trimming, setTrimming]             = useState(false);
  const [renameTarget, setRenameTarget]     = useState<string|null>(null);
  const [renameValue, setRenameValue]       = useState("");
  const [deleteTarget, setDeleteTarget]     = useState<string|null>(null);
  const [libPage, setLibPage]               = useState(0);
  const [selectedFiles, setSelectedFiles]   = useState<Set<string>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [deleteAllConfirm, setDeleteAllConfirm]   = useState(false);

  // ── Voice Studio sliders ────────────────────────────────────────────────────
  const [emotion, setEmotion]               = useState(50);
  const [speed, setSpeed]                   = useState(1.0);
  const [pitch, setPitch]                   = useState(0);
  const [volume, setVolume]                 = useState(80);
  const [styleStrength, setStyleStrength]   = useState(50);
  const [trimSilence, setTrimSilence]       = useState(false);
  const [masteringPreset, setMasteringPreset] = useState<"none"|"podcast"|"audiobook"|"broadcast">("none");

  // ── Voice picker ────────────────────────────────────────────────────────────
  const [voiceSearch, setVoiceSearch]           = useState("");
  const [genderFilter, setGenderFilter]         = useState<"All"|"Female"|"Male">("All");
  const [voicePickerTab, setVoicePickerTab]     = useState<"browse"|"train">("browse");
  const [toneFilter, setToneFilter]             = useState<"All"|Tone>("All");

  // ── AI Enhance ──────────────────────────────────────────────────────────────
  const [aiPunctuation, setAiPunctuation]   = useState(false);
  const [voiceStyle, setVoiceStyle]         = useState<VoiceStyle>("none");
  const [enhancing, setEnhancing]           = useState(false);
  const [originalText, setOriginalText]     = useState<string|null>(null);

  // ── Custom voices ───────────────────────────────────────────────────────────
  const [customVoices, setCustomVoices]         = useState<CustomVoice[]>([]);
  const [trainName, setTrainName]               = useState("");
  const [trainGender, setTrainGender]           = useState<"Female"|"Male">("Female");
  const [trainFile, setTrainFile]               = useState<string|null>(null);
  const [trainFileName, setTrainFileName]       = useState("");
  const [trainRefText, setTrainRefText]         = useState("");
  const [training, setTraining]                 = useState(false);
  const [trainStatus, setTrainStatus]           = useState("");
  const [trainStep, setTrainStep]               = useState(0);
  const [deleteVoiceTarget, setDeleteVoiceTarget] = useState<string|null>(null);

  // ── License ─────────────────────────────────────────────────────────────────
  const [licensed, setLicensed]             = useState(false);
  const [licenseKey, setLicenseKey]         = useState("");
  const [licenseActivating, setLicenseActivating] = useState(false);
  const [licenseError, setLicenseError]     = useState("");

  // ── First-time setup ────────────────────────────────────────────────────────
  const [setupChecked, setSetupChecked]     = useState(false);
  const [setupNeeded, setSetupNeeded]       = useState(false);
  const [setupRunning, setSetupRunning]     = useState(false);
  const [setupLog, setSetupLog]             = useState<string[]>([]);
  const [setupComplete, setSetupComplete]   = useState(false);
  const [setupErr, setSetupErr]             = useState("");
  const setupLogRef                         = useRef<HTMLDivElement>(null);

  // ── Auto-update ─────────────────────────────────────────────────────────────
  const [pendingUpdate, setPendingUpdate]   = useState<Update|null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updating, setUpdating]             = useState(false);

  useEffect(()=>{
    check().then(u=>{ if(u?.available) setPendingUpdate(u); }).catch(()=>{});
  },[]);

  const installUpdate = async () => {
    if(!pendingUpdate) return;
    setUpdating(true);
    try {
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    } catch(e) {
      setUpdating(false);
      showToast("Update failed: "+String(e), false);
    }
  };

  // ── License + setup check on mount ──────────────────────────────────────────
  useEffect(()=>{
    Promise.all([
      invoke<boolean>('check_setup_complete').catch(()=>true),
      invoke<boolean>('check_license').catch(()=>false),
    ]).then(([setupOk, licenseOk])=>{
      setSetupChecked(true);
      setSetupNeeded(!setupOk);
      setLicensed(licenseOk);
    });
  },[]);

  useEffect(()=>{
    const strip = (s:string)=>s.replace(/\[[0-9;]*m/g,'').replace(/\r/g,'');
    const u1 = listen<string>('setup-log', e=>{
      setSetupLog(p=>[...p.slice(-300), strip(e.payload)]);
      requestAnimationFrame(()=>{ setupLogRef.current?.scrollTo({top:99999,behavior:'smooth'}); });
    });
    const u2 = listen('setup-done', ()=>setSetupComplete(true));
    const u3 = listen<string>('setup-error', e=>{ setSetupErr(e.payload); setSetupRunning(false); });
    return ()=>{ u1.then(f=>f()); u2.then(f=>f()); u3.then(f=>f()); };
  },[]);

  // ── Settings panel ──────────────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen]     = useState(false);
  const [brightness, setBrightness]         = useState<BrightnessMode>("dark");
  const [activeTab, setActiveTab]           = useState(0);

  useEffect(()=>{
    const v = BRIGHTNESS[brightness];
    const r = document.documentElement.style;
    r.setProperty("--bg",  v.bg);
    r.setProperty("--s1",  v.panel);
    r.setProperty("--s2",  v.input);
    r.setProperty("--s3",  v.cardBg);
    r.setProperty("--s4",  v.cardBgAlt);
    r.setProperty("--ln",  v.panelBorder);
  },[brightness]);
  const [refreshing, setRefreshing]         = useState(false);

  // ── Merged voice list ────────────────────────────────────────────────────────
  const VOICES: VoiceEntry[] = [
    ...customVoices.map(cv => ({
      id: cv.id, name: cv.name, gender: cv.gender as "Female"|"Male",
      tone: "Custom" as Tone,
      engine: cv.engine || `openvoice_v2|${cv.id}`, isCustom: true, category: "Custom" as const,
    })),
    ...BUILT_IN_VOICES,
  ];
  const selectedVoiceEntry = VOICES.find(v=>v.id===voice) ?? VOICES[0];


  const filteredVoices = VOICES.filter(v => {
    const q = voiceSearch.toLowerCase();
    const matchSearch = !q || v.name.toLowerCase().includes(q) || v.tone.toLowerCase().includes(q);
    const matchGender = genderFilter==="All" || v.gender===genderFilter;
    const matchTone   = toneFilter==="All" || v.tone===toneFilter;
    return matchSearch && matchGender && matchTone;
  });

  const filteredKokoroVoices  = filteredVoices.filter(v => v.category === "Kokoro");
  const filteredClassicVoices = filteredVoices.filter(v => v.category !== "Kokoro");
  const groupedVoices = TONE_ORDER.reduce((acc,tone)=>{
    const g = filteredClassicVoices.filter(v=>v.tone===tone);
    if (g.length) acc[tone]=g;
    return acc;
  },{} as Record<Tone,VoiceEntry[]>);
  const groupedKokoro = KOKORO_LANGS.reduce((acc,lang)=>{
    const g = filteredKokoroVoices.filter(v => v.lang === lang);
    if (g.length) acc[lang] = g;
    return acc;
  },{} as Record<string,VoiceEntry[]>);

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const waveRef        = useRef<HTMLDivElement>(null);
  const waveSurferRef  = useRef<WaveSurfer|null>(null);
  const trainTimerRef  = useRef<ReturnType<typeof setInterval>|null>(null);
  const cardWaveSurferRef   = useRef<WaveSurfer|null>(null);
  const pendingCardBytesRef = useRef<number[]|null>(null);
  const cardTimerRef        = useRef<ReturnType<typeof setInterval>|null>(null);

  const wordCount = text.trim()==="" ? 0 : text.trim().split(/\s+/).length;
  const charCount = text.length;

  // ── Model check — runs after license + setup are confirmed done ──────────────
  useEffect(()=>{
    if (!setupChecked || !licensed || setupNeeded) return;
    (async () => {
      // Show debug paths in UI panel
      try {
        const paths = await invoke<string>("debug_paths");
        setDebugInfo(paths);
      } catch(e) { setDebugInfo("debug_paths failed: " + String(e)); }

      // Primary check — actual files on disk
      let already = false;
      try {
        already = await invoke<boolean>("check_model_downloaded");
      } catch {
        setModelReady(true); // Rust commands not registered (dev/test mode)
        return;
      }

      if (already) { setModelReady(true); return; }

      // Secondary check — trust progress.json "done" status.
      // Handles the case where xtts_model_dir() hasn't found the right path yet.
      try {
        const raw = await invoke<string>("read_download_progress");
        if (raw && (raw.includes('"done"') || raw.includes('"already_downloaded"'))) {
          setModelReady(true);
          return;
        }
      } catch {}

      // Spawn the downloader
      try {
        await invoke<string>("start_download");
      } catch (e) {
        setDlError(String(e));
        return;
      }

      // Poll every 1s
      let stuckTicks = 0;
      const pollInterval = setInterval(async () => {
        try {
          const raw = await invoke<string>("read_download_progress");
          if (!raw || raw.includes('"waiting"')) {
            stuckTicks++;
            if (stuckTicks % 3 === 0) {
              try {
                const log = await invoke<string>("read_stderr_log");
                if (log?.trim()) setDebugInfo("── stderr ──\n" + log.slice(-2000));
              } catch {}
            }
            return;
          }
          stuckTicks = 0;
          const p: DownloadProgress = JSON.parse(raw);
          setDlProgress(p);
          if (p.status === "done" || p.status === "already_downloaded") {
            clearInterval(pollInterval);
            setTimeout(() => setModelReady(true), 600);
          } else if (p.status === "error") {
            clearInterval(pollInterval);
            setDlError(p.message ?? "Unknown download error");
          }
        } catch {}
      }, 1000);
    })();
  }, [setupChecked, licensed, setupNeeded]);

  // ── Data loaders ─────────────────────────────────────────────────────────────
  const loadHistory = async () => {
    try { setAudioFiles(await invoke<AudioFile[]>("get_history_details")); } catch { /* ignore */ }
  };
  const loadCustomVoices = async () => {
    try { setCustomVoices(await invoke<CustomVoice[]>("list_custom_voices")); } catch { /* ignore */ }
  };
  const loadLatestWaveform = async () => {
    try {
      const bytes = await invoke<number[]>("get_audio_bytes");
      await waveSurferRef.current?.loadBlob(new Blob([new Uint8Array(bytes)],{type:"audio/wav"}));
    } catch { /* ignore */ }
  };
  const cardWaveCallback = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      const ws = cardWaveSurferRef.current;
      cardWaveSurferRef.current = null;
      if (ws) setTimeout(() => ws.destroy(), 0);
      return;
    }
    const bytes = pendingCardBytesRef.current;
    if (!bytes) return;
    const ws = WaveSurfer.create({
      container: node,
      height: 64,
      waveColor: "rgba(96,165,250,0.7)",
      progressColor: "#3b82f6",
      cursorColor: "rgba(255,255,255,0.5)",
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 3,
      normalize: true,
      interact: true,
    });
    ws.loadBlob(new Blob([new Uint8Array(bytes)], {type:"audio/wav"}))
      .then(() => ws.play())
      .catch(() => setPlayingFile(null));
    ws.on("finish", () => setPlayingFile(null));
    cardWaveSurferRef.current = ws;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const playCardAudio = async (filename:string) => {
    if (playingFile === filename) {
      cardWaveSurferRef.current?.stop();
      cardWaveSurferRef.current?.destroy();
      cardWaveSurferRef.current = null;
      pendingCardBytesRef.current = null;
      setPlayingFile(null);
      return;
    }
    if (cardWaveSurferRef.current) {
      cardWaveSurferRef.current.destroy();
      cardWaveSurferRef.current = null;
    }
    pendingCardBytesRef.current = null;
    try {
      const bytes = await invoke<number[]>("get_audio_file",{filename});
      pendingCardBytesRef.current = bytes;
      setCardPlayTime(0);
      setPlayingFile(filename);
    } catch { setPlayingFile(null); }
  };

  // ── Training step ticker ─────────────────────────────────────────────────────
  const startStepTicker = () => {
    setTrainStep(0); let step=0;
    trainTimerRef.current = setInterval(()=>{ step=Math.min(step+1,TRAIN_STEPS.length-1); setTrainStep(step); },18000);
  };
  const stopStepTicker = () => { if(trainTimerRef.current){clearInterval(trainTimerRef.current);trainTimerRef.current=null;} };

  // ── Refresh UI ───────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{msg:string;ok:boolean}|null>(null);
  const showToast = (msg:string, ok=true) => {
    setToast({msg,ok});
    setTimeout(()=>setToast(null), 3000);
  };

  const handleActivateLicense = async () => {
    if (!licenseKey.trim()) return;
    setLicenseActivating(true);
    setLicenseError("");
    try {
      await invoke('activate_license', { key: licenseKey.trim() });
      setLicensed(true);
    } catch(e) {
      setLicenseError(String(e));
    } finally {
      setLicenseActivating(false);
    }
  };

  const refreshUI = async () => {
    setRefreshing(true);
    setStatus("Refreshing…");
    setText("");
    setOriginalText(null);
    setMainFileName("");
    setMainCurrentTime(0);
    setMainDuration(0);
    setMainIsPlaying(false);
    waveSurferRef.current?.stop();
    waveSurferRef.current?.empty();
    await loadHistory();
    await loadCustomVoices();
    setTimeout(()=>{ setRefreshing(false); setStatus("Ready"); },600);
  };

  // ── Init waveform — only runs after model is ready (waveRef exists) ────────
  useEffect(()=>{
    if (modelReady !== true || !waveRef.current) return;
    const ws = WaveSurfer.create({
      container: waveRef.current,
      height: 110,
      waveColor: "rgba(56,100,200,0.55)",
      progressColor: "rgba(96,165,250,0.9)",
      cursorColor: "rgba(255,255,255,0.6)",
      cursorWidth: 1,
      barWidth: 3,
      barGap: 2,
      barRadius: 4,
      normalize: true,
      interact: true,
    });
    ws.on("play",       ()        => setMainIsPlaying(true));
    ws.on("pause",      ()        => setMainIsPlaying(false));
    ws.on("finish",     ()        => setMainIsPlaying(false));
    ws.on("timeupdate", (t:number)=> setMainCurrentTime(t));
    ws.on("ready",      (dur:number)=>{ setMainDuration(dur); setTrimEnd(dur); setTrimStart(0); });
    waveSurferRef.current = ws;
    loadHistory();
    loadCustomVoices();
    return ()=>{ waveSurferRef.current?.destroy(); stopStepTicker(); };
  },[modelReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Card play timer ──────────────────────────────────────────────────────────
  useEffect(()=>{
    if (!playingFile) {
      if (cardTimerRef.current) { clearInterval(cardTimerRef.current); cardTimerRef.current=null; }
      return;
    }
    cardTimerRef.current = setInterval(()=>setCardPlayTime(t=>t+1), 1000);
    return ()=>{ if (cardTimerRef.current) { clearInterval(cardTimerRef.current); cardTimerRef.current=null; } };
  },[playingFile]);

  // ── AI Enhance ───────────────────────────────────────────────────────────────
  const enhanceScript = async () => {
    if (!text.trim()) { setStatus("Please enter text first"); return; }
    const mode:EnhanceMode = aiPunctuation&&voiceStyle!=="none"?"both":aiPunctuation?"punctuation":voiceStyle!=="none"?"style":"none";
    if (mode==="none") { setStatus("Enable AI Punctuation or pick a Voice Style first"); return; }
    try {
      setEnhancing(true); setStatus("Enhancing script…"); setOriginalText(text);
      const enhanced = await invoke<string>("enhance_script",{text,mode,style:voiceStyle});
      if (enhanced.trim() === text.trim()) {
        setStatus("No changes — try different text or style");
      } else {
        setText(enhanced); setStatus("Script enhanced ✓");
      }
    } catch(e) { setStatus("Enhance failed: "+String(e)); }
    finally { setEnhancing(false); }
  };
  const undoEnhance = () => { if(originalText!==null){setText(originalText);setOriginalText(null);setStatus("Reverted to original");} };

  // ── Generate ─────────────────────────────────────────────────────────────────
  const generateVoice = async () => {
    if (!text.trim()) { setStatus("Please enter text"); return; }
    try {
      const start = now();
      // Auto-apply voice style silently before generating if one is selected
      let finalText = text;
      if (voiceStyle !== "none") {
        setStatus("Applying style…");
        try {
          const mode: "style"|"both" = aiPunctuation ? "both" : "style";
          const styled = await invoke<string>("enhance_script", {text, mode, style: voiceStyle});
          if (styled.trim()) finalText = styled;
        } catch { /* fall through with original text */ }
      }
      setStatus("Generating…");
      const result = await invoke<string>("generate_voice",{
        text:finalText,voice,voiceEngine:selectedVoiceEntry.engine,
        emotion,speed,pitch,volume,styleStrength,trimSilence,masteringPreset,
      });
      const filename = result.trim().split('\n').map(l=>l.trim()).filter(Boolean).pop() ?? result.trim();
      setGenerationTime(((now()-start)/1000).toFixed(2)+" sec");
      setStatus("Done — "+filename);
      setMainFileName(filename);
      await loadLatestWaveform(); await loadHistory();
      try { await invoke("save_audio_meta",{filename,voiceName:selectedVoiceEntry.name}); } catch { /* ignore */ }
    } catch(e) { setStatus("Generation failed: "+String(e)); }
  };

  const playAudio  = () => waveSurferRef.current?.play();
  const pauseAudio = () => waveSurferRef.current?.pause();


  // ── Trim ──────────────────────────────────────────────────────────────────────
  const applyTrim = async () => {
    if (!mainFileName) { setStatus("No audio loaded to trim"); return; }
    const safeFile = mainFileName.split('/').pop()?.split('\\').pop() ?? mainFileName;
    try {
      setTrimming(true); setStatus("Trimming…");
      const result = await invoke<string>("trim_audio",{filename:safeFile,startSec:trimStart,endSec:trimEnd});
      setMainFileName(result);
      try { await invoke("save_audio_meta",{filename:result,voiceName:selectedVoiceEntry.name+" (trimmed)"}); } catch { /* ignore */ }
      setStatus("Trimmed — "+result);
      await loadLatestWaveform(); await loadHistory();
    } catch(e) { setStatus("Trim failed: "+String(e)); }
    finally { setTrimming(false); }
  };

  // ── File actions ─────────────────────────────────────────────────────────────
  const startRename  = (f:string)=>{ setRenameTarget(f); setRenameValue(f.replace(/\.wav$/i,"")); };
  const confirmRename = async () => {
    if(!renameTarget||!renameValue.trim()) return;
    try {
      await invoke("rename_audio_file",{oldName:renameTarget,newName:renameValue.trim()});
      const nf = renameValue.trim().endsWith(".wav")?renameValue.trim():renameValue.trim()+".wav";
      if(selectedFile===renameTarget) setSelectedFile(nf);
      setRenameTarget(null); setRenameValue(""); await loadHistory();
    } catch(e){setStatus("Rename failed: "+String(e));}
  };
  const confirmDelete = async () => {
    if(!deleteTarget) return;
    try {
      await invoke("delete_audio_file",{filename:deleteTarget});
      if(selectedFile===deleteTarget){setSelectedFile("");waveSurferRef.current?.empty();}
      setDeleteTarget(null); await loadHistory();
    } catch(e){setStatus("Delete failed: "+String(e));setDeleteTarget(null);}
  };
  const downloadFile = async (filename:string) => {
    try {
      await invoke("save_to_downloads", {filenames:[filename]});
      showToast(`Saved "${filename}" to ~/Downloads`);
    } catch(e){showToast("Download failed: "+String(e), false);}
  };
  const toggleFileSelect = (fn: string) =>
    setSelectedFiles(prev => { const n = new Set(prev); n.has(fn) ? n.delete(fn) : n.add(fn); return n; });
  const togglePageSelectAll = (paged: AudioFile[]) => {
    const all = paged.every(f => selectedFiles.has(f.filename));
    setSelectedFiles(prev => { const n = new Set(prev); paged.forEach(f => all ? n.delete(f.filename) : n.add(f.filename)); return n; });
  };
  const bulkDownload = async () => {
    try {
      const fns = Array.from(selectedFiles);
      await invoke("save_to_downloads", {filenames: fns});
      showToast(`Saved ${fns.length} file${fns.length!==1?"s":""} to ~/Downloads`);
    } catch(e){showToast("Bulk download failed: "+String(e), false);}
  };
  const confirmBulkDelete = async () => {
    try {
      for (const fn of Array.from(selectedFiles)) {
        await invoke("delete_audio_file",{filename:fn});
        if (selectedFile===fn) { setSelectedFile(""); waveSurferRef.current?.empty(); }
      }
      setSelectedFiles(new Set()); setBulkDeleteConfirm(false); await loadHistory();
    } catch(e){ setStatus("Bulk delete failed: "+String(e)); setBulkDeleteConfirm(false); }
  };
  const confirmDeleteAll = async () => {
    try {
      for (const f of audioFiles) {
        await invoke("delete_audio_file",{filename:f.filename});
      }
      setSelectedFile(""); waveSurferRef.current?.empty();
      setSelectedFiles(new Set()); setDeleteAllConfirm(false); await loadHistory();
    } catch(e){ setStatus("Delete all failed: "+String(e)); setDeleteAllConfirm(false); }
  };

  // ── Voice training ────────────────────────────────────────────────────────────
  const pickTrainFile = async () => {
    try {
      const sel = await open({multiple:false,filters:[{name:"Audio",extensions:["wav","mp3","m4a","ogg","flac"]}]});
      if(sel&&typeof sel==="string"){ setTrainFile(sel); setTrainFileName(sel.split(/[\\/]/).pop()??sel); setTrainStatus(""); }
    } catch(e){setTrainStatus("Could not open file picker: "+String(e));}
  };
  const startTraining = async () => {
    if(!trainFile){setTrainStatus("Please select an audio file first.");return;}
    if(!trainName.trim()){setTrainStatus("Please enter a name for this voice.");return;}
    if(!trainRefText.trim()){setTrainStatus("Please enter the transcript of the reference audio.");return;}
    try {
      setTraining(true); setTrainStatus(""); startStepTicker();
      const raw    = await invoke<string>("save_f5_voice",{
        audioPath:trainFile, voiceName:trainName.trim(), gender:trainGender, refText:trainRefText.trim()
      });
      const result = JSON.parse(raw);
      if(result.status==="ok"){
        setTrainStatus(`✓ Voice "${result.name}" saved! Ready to use with F5-TTS.`);
        setTrainName(""); setTrainFile(null); setTrainFileName(""); setTrainRefText("");
        await loadCustomVoices(); setVoice(result.id); setVoicePickerTab("browse");
      } else { setTrainStatus(`Error: ${result.message}`); }
    } catch(e){setTrainStatus("Save failed: "+String(e));}
    finally{stopStepTicker();setTraining(false);}
  };
  const confirmDeleteVoice = async () => {
    if(!deleteVoiceTarget) return;
    try {
      await invoke("delete_custom_voice",{voiceId:deleteVoiceTarget});
      if(voice===deleteVoiceTarget) setVoice("ljspeech_tacotron2");
      setDeleteVoiceTarget(null); await loadCustomVoices();
    } catch(e){setTrainStatus("Delete failed: "+String(e));setDeleteVoiceTarget(null);}
  };

  const filteredFiles = [...audioFiles]
    .filter(f=>f.filename.toLowerCase().includes(search.toLowerCase()))
    .sort((a,b)=>{
      switch(sortBy){
        case "oldest":   return a.filename.localeCompare(b.filename);
        case "longest":  return b.duration_secs - a.duration_secs;
        case "shortest": return a.duration_secs - b.duration_secs;
        case "largest":  return b.size - a.size;
        default:         return b.filename.localeCompare(a.filename);
      }
    });
  const libPageCount  = Math.ceil(filteredFiles.length / PAGE_SIZE);
  const safeLibPage   = Math.min(libPage, Math.max(0, libPageCount - 1));
  const pagedFiles    = filteredFiles.slice(safeLibPage * PAGE_SIZE, (safeLibPage + 1) * PAGE_SIZE);

  // ── First-time setup screens ─────────────────────────────────────────────────
  if (!setupChecked) return (
    <div style={{background:"#070c17",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <span style={{display:"inline-block",animation:"spin 1.2s linear infinite",color:"#3a4d66",fontSize:"22px"}}>⟳</span>
    </div>
  );

  if (!licensed) return (
    <div style={{background:"#070c17",minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"white",fontFamily:"'Inter',sans-serif",WebkitFontSmoothing:"antialiased",padding:"24px"}}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}} @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>

      <div style={{textAlign:"center",marginBottom:"28px",animation:"fadeIn .4s ease"}}>
        <div style={{fontSize:"38px",fontWeight:800,letterSpacing:"-1px",marginBottom:"6px",background:"linear-gradient(135deg,#f0f4ff,#a78bfa)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Curzon</div>
        <div style={{fontSize:"11px",color:"#3a4d66",textTransform:"uppercase",letterSpacing:"0.15em"}}>AI Voice Studio</div>
      </div>

      <div style={{background:"rgba(139,124,248,.08)",border:"1px solid rgba(139,124,248,.2)",borderRadius:"14px",padding:"28px 32px",width:"min(400px,92vw)",animation:"fadeIn .5s ease"}}>
        <div style={{fontSize:"15px",fontWeight:600,color:"#c4b5fd",marginBottom:"6px"}}>Activate Your License</div>
        <div style={{fontSize:"13px",color:"#4a5d7a",marginBottom:"20px",lineHeight:"1.5"}}>
          Enter the license key from your Gumroad purchase email.
        </div>

        <input
          type="text"
          placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
          value={licenseKey}
          onChange={e=>{ setLicenseKey(e.target.value.toUpperCase()); setLicenseError(""); }}
          onKeyDown={e=>{ if(e.key==="Enter" && !licenseActivating) handleActivateLicense(); }}
          disabled={licenseActivating}
          style={{width:"100%",padding:"10px 14px",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(139,124,248,0.3)",borderRadius:"8px",color:"#e0e8ff",fontSize:"13px",fontFamily:"monospace",outline:"none",boxSizing:"border-box",marginBottom:"12px",letterSpacing:"0.05em"}}
        />

        {licenseError && (
          <div style={{marginBottom:"12px",padding:"10px 14px",background:"rgba(248,113,113,.1)",border:"1px solid rgba(248,113,113,.25)",borderRadius:"8px",color:"#f87171",fontSize:"12.5px"}}>
            {licenseError}
          </div>
        )}

        <button
          onClick={handleActivateLicense}
          disabled={licenseActivating || !licenseKey.trim()}
          style={{width:"100%",padding:"12px",background:licenseActivating?"rgba(124,58,237,0.4)":"linear-gradient(135deg,#7c3aed,#4f46e5)",border:"none",borderRadius:"8px",color:"white",fontSize:"14px",fontWeight:600,cursor:licenseActivating?"wait":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:"8px",opacity:!licenseKey.trim()?0.5:1}}>
          {licenseActivating && <span style={{display:"inline-block",animation:"spin 1.2s linear infinite"}}>⟳</span>}
          {licenseActivating ? "Activating…" : "Activate"}
        </button>

        <div style={{marginTop:"16px",textAlign:"center",fontSize:"12px",color:"#2a3d56"}}>
          Don't have a license? Purchase at gumroad.com
        </div>
      </div>
    </div>
  );

  if (setupNeeded && !setupComplete) return (
    <div style={{background:"#070c17",minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"white",fontFamily:"'Inter',sans-serif",WebkitFontSmoothing:"antialiased",padding:"24px"}}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}} @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>

      <div style={{textAlign:"center",marginBottom:"28px",animation:"fadeIn .4s ease"}}>
        <div style={{fontSize:"38px",fontWeight:800,letterSpacing:"-1px",marginBottom:"6px",background:"linear-gradient(135deg,#f0f4ff,#a78bfa)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Curzon</div>
        <div style={{fontSize:"11px",color:"#3a4d66",textTransform:"uppercase",letterSpacing:"0.15em"}}>AI Voice Studio</div>
      </div>

      {!setupRunning && !setupErr && (
        <div style={{background:"rgba(139,124,248,.08)",border:"1px solid rgba(139,124,248,.2)",borderRadius:"14px",padding:"24px 28px",width:"min(420px,92vw)",animation:"fadeIn .5s ease"}}>
          <div style={{fontSize:"15px",fontWeight:600,color:"#c4b5fd",marginBottom:"20px"}}>First-time Setup Required</div>
          <button
            onClick={()=>{ setSetupRunning(true); invoke('run_setup').catch(e=>{ setSetupErr(String(e)); setSetupRunning(false); }); }}
            style={{width:"100%",padding:"12px",background:"linear-gradient(135deg,#7c3aed,#4f46e5)",border:"none",borderRadius:"8px",color:"white",fontSize:"14px",fontWeight:600,cursor:"pointer",letterSpacing:"0.02em"}}>
            Install Now
          </button>
        </div>
      )}

      {(setupRunning || setupErr) && (()=>{
        const { step, total, stepName, lastLine, pct } = parseSetupProgress(setupLog);
        return (
          <div style={{width:"min(420px,92vw)",animation:"fadeIn .3s ease"}}>
            {setupRunning && !setupErr && (
              <div style={{background:"rgba(139,124,248,.08)",border:"1px solid rgba(139,124,248,.2)",borderRadius:"14px",padding:"24px 28px"}}>
                <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"18px",color:"#a78bfa",fontSize:"13px",fontWeight:500}}>
                  <span style={{display:"inline-block",animation:"spin 1.2s linear infinite",flexShrink:0}}>⟳</span>
                  <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {step > 0 ? `Step ${step} of ${total} — ${stepName}` : "Starting setup…"}
                  </span>
                </div>
                <div style={{height:"6px",background:"rgba(255,255,255,0.07)",borderRadius:"3px",overflow:"hidden",marginBottom:"8px"}}>
                  <div style={{height:"100%",width:`${pct}%`,background:"linear-gradient(90deg,#7c3aed,#6366f1)",borderRadius:"3px",transition:"width 0.6s ease"}}/>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:"11px"}}>
                  <span style={{color:"#4a5d7a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"80%"}}>{lastLine || "Please wait…"}</span>
                  <span style={{color:"#6366f1",fontWeight:600,flexShrink:0,marginLeft:"8px"}}>{pct}%</span>
                </div>
              </div>
            )}
            {setupErr && (
              <div style={{padding:"16px 20px",background:"rgba(248,113,113,.1)",border:"1px solid rgba(248,113,113,.25)",borderRadius:"12px",color:"#f87171",fontSize:"13px"}}>
                <strong>Setup failed:</strong> {setupErr}
                <div style={{color:"#8896b0",marginTop:"8px"}}>
                  You can also run <code style={{background:"rgba(255,255,255,.07)",padding:"2px 7px",borderRadius:"4px"}}>bash setup.sh</code> in Terminal, then relaunch.
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );

  if (setupComplete) return (
    <div style={{background:"#070c17",minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"white",fontFamily:"'Inter',sans-serif",WebkitFontSmoothing:"antialiased"}}>
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{textAlign:"center",animation:"fadeIn .4s ease"}}>
        <div style={{fontSize:"42px",marginBottom:"16px"}}>✓</div>
        <div style={{fontSize:"22px",fontWeight:700,color:"#6ee7b7",marginBottom:"8px"}}>Setup Complete!</div>
        <div style={{fontSize:"14px",color:"#8896b0",marginBottom:"28px"}}>All AI voice models are ready.</div>
        <button onClick={()=>relaunch()}
          style={{padding:"12px 32px",background:"linear-gradient(135deg,#7c3aed,#4f46e5)",border:"none",borderRadius:"8px",color:"white",fontSize:"14px",fontWeight:600,cursor:"pointer"}}>
          Launch Curzon
        </button>
      </div>
    </div>
  );

  // ── Show appropriate screen until model is ready ────────────────────────────
  if (modelReady !== true) {
    // Download already started (or failed) → show full download screen
    if (dlProgress !== null || dlError) {
      return <DownloadScreen progress={dlProgress} error={dlError} debugInfo={debugInfo} />;
    }
    // Still checking disk — show a minimal splash so returning users don't see the download screen
    return (
      <div style={{ backgroundColor:"#070c17", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", color:"white", WebkitFontSmoothing:"antialiased" }}>
        <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:"42px", fontWeight:800, letterSpacing:"-1px", marginBottom:"8px", background:"linear-gradient(135deg,#f0f4ff,#a78bfa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>Curzon VoiceAI</div>
          <div style={{ fontSize:"10px", color:"#3a4d66", textTransform:"uppercase", letterSpacing:"0.15em", marginBottom:"32px" }}>AI Voice Studio</div>
          <div style={{ fontSize:"13px", color:"#3a4d66", display:"flex", alignItems:"center", justifyContent:"center", gap:"10px" }}>
            <span style={{ display:"inline-block", animation:"spin 1.2s linear infinite" }}>⟳</span>
            Checking OpenVoice V2 model…
          </div>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div>
      <style>{`
        input[type=range]{-webkit-appearance:none;appearance:none;}
        input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;}
      `}</style>

      {/* ── Toast ── */}
      {toast&&(
        <div style={{position:"fixed",bottom:"28px",left:"50%",transform:"translateX(-50%)",zIndex:9000,
          background:toast.ok?"rgba(10,20,40,0.95)":"rgba(40,10,10,0.95)",
          border:`1px solid ${toast.ok?"rgba(94,234,212,.35)":"rgba(248,113,113,.35)"}`,
          borderRadius:"10px",padding:"11px 20px",display:"flex",alignItems:"center",gap:"10px",
          boxShadow:"0 8px 32px rgba(0,0,0,0.5)",backdropFilter:"blur(12px)",
          fontSize:"13px",color:toast.ok?"var(--mint)":"var(--rose)",whiteSpace:"nowrap",animation:"fadeIn .2s ease"}}>
          <i className={`ti ${toast.ok?"ti-circle-check":"ti-alert-circle"}`} style={{fontSize:"16px"}}/>
          {toast.msg}
        </div>
      )}

      {/* ── Update banner ── */}
      {pendingUpdate&&!updateDismissed&&(
        <div style={{display:"flex",alignItems:"center",gap:"12px",padding:"10px 20px",
          background:"linear-gradient(135deg,rgba(139,124,248,.18),rgba(91,62,232,.12))",
          borderBottom:"1px solid rgba(139,124,248,.28)",flexWrap:"wrap"}}>
          <i className="ti ti-sparkles" style={{color:"var(--acc2)",fontSize:"15px",flexShrink:0}}/>
          <span style={{flex:1,fontSize:"13px",color:"var(--t1)"}}>
            <strong style={{color:"var(--acc2)"}}>Update available</strong>
            {pendingUpdate.version&&` — v${pendingUpdate.version}`}
            {pendingUpdate.body&&<span style={{color:"var(--t3)",marginLeft:"8px",fontSize:"11px"}}>{pendingUpdate.body}</span>}
          </span>
          <button onClick={installUpdate} disabled={updating}
            style={{padding:"6px 16px",borderRadius:"var(--r2)",cursor:updating?"not-allowed":"pointer",
              background:"linear-gradient(135deg,var(--acc),#5b3ee8)",color:"white",border:"none",
              fontSize:"12px",fontWeight:600,fontFamily:"inherit",opacity:updating?0.7:1,flexShrink:0}}>
            {updating?"Installing…":"Update Now"}
          </button>
          <button onClick={()=>setUpdateDismissed(true)}
            style={{padding:"6px 12px",borderRadius:"var(--r2)",cursor:"pointer",
              background:"transparent",border:"1px solid var(--ln2)",color:"var(--t3)",
              fontSize:"12px",fontFamily:"inherit",flexShrink:0}}>
            Later
          </button>
        </div>
      )}

      {/* ── Nav ── */}
      <div className="nav">
        <div className={`nt${activeTab===0?" a":""}`} onClick={()=>setActiveTab(0)}>Voice Studio</div>
        <div className={`nt${activeTab===1?" a":""}`} onClick={()=>setActiveTab(1)}>Library</div>
        <div className={`nt${activeTab===2?" a":""}`} onClick={()=>setActiveTab(2)}>Voice Library</div>
      </div>

      {/* ════════ TAB 0: VOICE STUDIO ════════ */}
      <div className={`sc${activeTab===0?" a":""}`}>
        <div className="app">
          <div className="topbar" style={{gridColumn:"1/-1"}}>
            <div>
              <div className="brand">CURZON <em>VOICEAI</em></div>
              <div className="brand-sub">AI Voice Studio</div>
            </div>
            <div className="hbtns">
              <button className="hb" onClick={refreshUI}>
                <i className="ti ti-refresh" style={{display:"inline-block",transition:"transform .6s",transform:refreshing?"rotate(360deg)":"none"}}/>
                {refreshing?"Refreshing…":"Refresh"}
              </button>
              <button className="hb" onClick={()=>setSettingsOpen(true)}>
                <i className="ti ti-settings"/>Settings
              </button>
            </div>
          </div>

          {/* Left col */}
          <div className="left-col">
            <div className="sec-lbl" style={{marginTop:0}}>Voice</div>
            <div className="vstage" onClick={()=>setActiveTab(2)}>
              <div className="vstage-bg">{selectedVoiceEntry.name.charAt(0)}</div>
              <div className="vstage-top">
                <div className="va2">{selectedVoiceEntry.name.charAt(0)}</div>
                <div>
                  <div className="vn">
                    {selectedVoiceEntry.name}
                    {selectedVoiceEntry.isCustom&&<span style={{marginLeft:"6px",fontSize:"10px",color:"var(--acc2)",background:"var(--accg2)",padding:"1px 5px",borderRadius:"4px"}}>CUSTOM</span>}
                  </div>
                  <div className="vsub">
                    {selectedVoiceEntry.gender} · {selectedVoiceEntry.isCustom?"Custom":selectedVoiceEntry.lang?(KOKORO_LANG_INFO[selectedVoiceEntry.lang]?.label??selectedVoiceEntry.lang):"Classic"}
                  </div>
                </div>
                <div className="vstage-chev"><i className="ti ti-chevron-down"/></div>
              </div>
              <div className="vstags">
                <span className="vtag">{selectedVoiceEntry.tone}</span>
                <span className="vtag">{selectedVoiceEntry.gender}</span>
                {selectedVoiceEntry.category==="Kokoro"&&<span className="vtag">Premium</span>}
              </div>
            </div>
            <button className="train" onClick={()=>{setActiveTab(2);setVoicePickerTab("train");}}>
              <i className="ti ti-microphone"/>Train Custom Voice
            </button>
            <div className="sec-lbl">Parameters</div>
            <div className="sliders">
              <CSSSlider label="Emotion" icon="ti-chart-bar" value={emotion} setValue={setEmotion} min={0} max={100} step={1} fmt={v=>v<30?"Calm":v<60?"Neutral":v<85?"Expressive":"Intense"}/>
              <CSSSlider label="Speed" icon="ti-bolt" value={speed} setValue={setSpeed} min={0.5} max={2.0} step={0.05} fmt={v=>v.toFixed(2)+"×"}/>
              <CSSSlider label="Pitch" icon="ti-music" value={pitch} setValue={setPitch} min={-10} max={10} step={0.5} fmt={v=>(v>=0?"+":"")+v+" st"}/>
              <CSSSlider label="Volume" icon="ti-volume" value={volume} setValue={setVolume} min={0} max={100} step={1} fmt={v=>v+"%"}/>
            </div>
            <div className="tgl-row">
              <span className="tgl-lbl"><i className="ti ti-cut"/>Silence Trim</span>
              <div className={`sw${trimSilence?" on":""}`} onClick={()=>setTrimSilence(!trimSilence)}><div className="nb"/></div>
            </div>
            <div className="sec-lbl">Mastering</div>
            <div className="mast">
              {(["none","podcast","audiobook","broadcast"] as const).map(p=>(
                <div key={p} className={`mast-i${masteringPreset===p?" on":""}`} onClick={()=>setMasteringPreset(p)}>
                  {p==="none"?"Raw":p==="podcast"?"Podcast":p==="audiobook"?"Audiobook":"Broadcast"}
                </div>
              ))}
            </div>
            {masteringPreset!=="none"&&(
              <div className="chain-txt">
                {masteringPreset==="podcast"   &&"Noise gate · HP 80Hz · Comp 3:1 · +2.5dB presence · Limiter"}
                {masteringPreset==="audiobook" &&"Noise gate · Comp 2:1 · Warmth +1.5dB · Room reverb 7% · Limiter"}
                {masteringPreset==="broadcast" &&"Noise gate · HP 100Hz · Comp 4:1 · Air +1.5dB · Presence +3dB · Limiter"}
              </div>
            )}
            <button onClick={()=>{setEmotion(50);setSpeed(1.0);setPitch(0);setVolume(80);setStyleStrength(50);setTrimSilence(false);setMasteringPreset("none");}}
              style={{marginTop:"16px",width:"100%",padding:"8px",background:"transparent",border:"1px solid var(--ln2)",color:"var(--t4)",borderRadius:"var(--r2)",cursor:"pointer",fontSize:"12px",fontFamily:"inherit"}}>
              ↺ Reset to Defaults
            </button>
          </div>

          {/* Right col */}
          <div className="right-col">
            <div className="aip">
              <div className="aip-hd">
                <span className="aip-title"><i className="ti ti-sparkles"/>AI Enhancement</span>
                <span className="badge-ol">offline · free</span>
              </div>
              <div className="smart">
                <div className="smart-l">
                  <div className="st"><i className="ti ti-typography"/>Smart Punctuation</div>
                  <div className="ss">Auto-inserts commas, pauses &amp; sentence breaks</div>
                </div>
                <div className={`sw${aiPunctuation?" on":""}`} onClick={()=>setAiPunctuation(!aiPunctuation)}><div className="nb"/></div>
              </div>
              <div className="sty-lbl">Voice Style</div>
              <div className="sty-grid">
                {VOICE_STYLES.map(s=>(
                  <div key={s.id} className={`sty-c${voiceStyle===s.id?" on":""}`} onClick={()=>setVoiceStyle(s.id)} title={s.desc}>
                    <div className="sty-ico"><i className={`ti ${s.icon}`}/></div>
                    <span className="sty-nm">{s.label}</span>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:"8px"}}>
                <button className="enh-btn" onClick={enhanceScript} disabled={enhancing} style={{flex:1}}>
                  <i className="ti ti-sparkles"/>{enhancing?"Enhancing…":"Enhance Script"}
                </button>
                {originalText!==null&&(
                  <button onClick={undoEnhance}
                    style={{padding:"12px 14px",borderRadius:"var(--r2)",cursor:"pointer",background:"transparent",border:"1px solid var(--ln2)",color:"var(--t2)",fontSize:"13px",fontFamily:"inherit"}}>
                    ↩ Undo
                  </button>
                )}
              </div>
            </div>
            <div className="script-box">
              <textarea value={text} onChange={e=>{setText(e.target.value);setOriginalText(null);}} placeholder="Enter your script…" rows={8}/>
              <div className="script-footer">
                <div className="sf-count"><span>{wordCount} words</span><span>{charCount} chars</span></div>
                <div style={{fontSize:"11px",color:status.includes("failed")||status.includes("Failed")?"var(--rose)":status.includes("Done")||status.includes("ready")?"var(--mint)":"var(--t4)"}}>{status}</div>
              </div>
            </div>
            <div className="act-row">
              <button className="gen-btn" onClick={generateVoice}>Generate</button>
              <button className="play-btn" onClick={playAudio} disabled={!mainFileName} style={{opacity:mainFileName?1:0.4,cursor:mainFileName?"pointer":"not-allowed"}}><i className="ti ti-player-play"/></button>
              <button className="pause-btn" onClick={pauseAudio} disabled={!mainFileName} style={{opacity:mainFileName?1:0.4,cursor:mainFileName?"pointer":"not-allowed"}}><i className="ti ti-player-pause"/></button>
            </div>
            <div className="wave-block" style={{marginTop:"12px"}}>
              <div className="wave-top">
                <div className="wave-status">
                  <div className="wave-dot" style={{background:mainIsPlaying?"var(--mint)":mainCurrentTime>0?"var(--acc)":"var(--t3)"}}/>
                  {mainIsPlaying?"Playing":mainCurrentTime>0?"Paused":"Ready"}
                </div>
                <div className="wave-timer">
                  {formatDuration(Math.floor(mainCurrentTime))} <span>/ {formatDuration(Math.floor(mainDuration))}</span>
                </div>
              </div>
              <div ref={waveRef} style={{padding:"4px 20px 0",minHeight:"88px"}}/>
              <div className="wave-controls">
                <TrimField label="Start (sec)" value={Math.round(trimStart)}
                  setValue={v=>setTrimStart(Math.min(v,Math.round(trimEnd)-1))}
                  min={0} max={Math.max(0,Math.round(trimEnd)-1)}/>
                <div className="trim-sep">–</div>
                <TrimField label="End (sec)" value={Math.round(trimEnd)}
                  setValue={v=>setTrimEnd(Math.max(v,Math.round(trimStart)+1))}
                  min={Math.round(trimStart)+1} max={Math.round(mainDuration)||999}/>
                <div className="trim-sel" style={{marginLeft:"16px"}}>
                  Selected:&nbsp;<strong>{formatDuration(Math.max(0,Math.round(trimEnd)-Math.round(trimStart)))}</strong>
                </div>
                <button className="trim-btn" style={{marginLeft:"auto"}} onClick={applyTrim} disabled={trimming||!mainFileName}>
                  <i className="ti ti-cut"/>{trimming?"Trimming…":"Trim & Save"}
                </button>
              </div>
            </div>
            {mainFileName&&(
              <div className="done-bar" style={{marginTop:"8px"}}>
                <div className="done-l"><i className="ti ti-check"/>Done — {mainFileName}</div>
                <div className="done-r">
                  <span className="stat-p">{wordCount} words</span>
                  <span className="stat-p">{charCount} chars</span>
                  {generationTime&&<span className="stat-p">{generationTime}</span>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ════════ TAB 1: LIBRARY ════════ */}
      <div className={`sc${activeTab===1?" a":""}`}>
        <div className="s2body">
          <div className="lib">
            <div className="lib-hd">
              <div className="lib-title">Audio Library <span className="cnt">{filteredFiles.length}</span></div>
              <div className="lib-acts">
                {selectedFiles.size>0&&<>
                  <button className="del-sel-btn" onClick={bulkDownload}>⬇ Download ({selectedFiles.size})</button>
                  <button className="del-sel-btn" onClick={()=>setBulkDeleteConfirm(true)}>Delete Selected</button>
                </>}
                {audioFiles.length>0&&<button className="del-all-btn" onClick={()=>setDeleteAllConfirm(true)}>Delete All</button>}
              </div>
            </div>
            <div className="lib-filters">
              {(["newest","oldest","longest","shortest","largest"] as const).map(s=>(
                <div key={s} className={`sort-chip${sortBy===s?" on":""}`} onClick={()=>{setSortBy(s);setLibPage(0);}}>
                  {s==="newest"?"Newest":s==="oldest"?"Oldest":s==="longest"?"Longest":s==="shortest"?"Shortest":"Largest"}
                </div>
              ))}
            </div>
            <div className="lib-search-row">
              <input className="lib-si" type="text" placeholder="Search recordings…" value={search}
                onChange={e=>{setSearch(e.target.value);setLibPage(0);}}/>
              {pagedFiles.length>0&&(
                <label className="sel-all">
                  <input type="checkbox" checked={pagedFiles.every(f=>selectedFiles.has(f.filename))}
                    onChange={()=>togglePageSelectAll(pagedFiles)} style={{width:"15px",height:"15px",accentColor:"var(--acc)"}}/>
                  Select all
                </label>
              )}
            </div>

            {pagedFiles.map(file=>{
              const isSel  = selectedFiles.has(file.filename);
              const isPlay = playingFile===file.filename;
              const bars   = waveHeights(file.filename,88);
              const fv     = BUILT_IN_VOICES.find(v=>v.name===file.voice_name);
              const isCustomV = !fv&&!!file.voice_name;
              return (
                <div key={file.filename} className={`rr${isSel?" sel":""}`} onClick={()=>toggleFileSelect(file.filename)}>
                  <div className="rr-inner">
                    <div className="rr-top">
                      <div className="rr-chk"/>
                      <span className="rr-name">{file.filename}</span>
                      <div className="rr-ibts" onClick={e=>e.stopPropagation()}>
                        <button className="rr-ib p" onClick={()=>playCardAudio(file.filename)}>
                          <i className={`ti ${isPlay?"ti-player-stop":"ti-player-play"}`}/>
                        </button>
                        <button className="rr-ib d" onClick={()=>downloadFile(file.filename)}><i className="ti ti-download"/></button>
                        <button className="rr-ib r" onClick={()=>startRename(file.filename)}><i className="ti ti-pencil"/></button>
                        <button className="rr-ib x" onClick={()=>setDeleteTarget(file.filename)}><i className="ti ti-trash"/></button>
                      </div>
                      <div className="rr-dur">{formatDuration(file.duration_secs)}</div>
                    </div>
                    <div className="rr-meta">
                      {file.voice_name&&<span className={`voice-pill ${isCustomV?"cust":"std"}`}>{file.voice_name}</span>}
                      <span className="rr-date">{formatCreated(Number(file.created))}</span>
                      <span className="rr-sz">{formatSize(file.size)}</span>
                    </div>
                    <div className="rr-waveform">
                      {isPlay?(
                        <div ref={cardWaveCallback} style={{flex:1,height:"28px",borderRadius:"4px",overflow:"hidden"}} onClick={e=>e.stopPropagation()}/>
                      ):(
                        bars.map((h,i)=>(
                          <div key={i} className="rb" style={{height:`${h}px`,background:isSel?"rgba(139,124,248,0.55)":"rgba(139,124,248,0.25)"}}/>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredFiles.length===0&&(
              <div style={{textAlign:"center",color:"var(--t4)",padding:"40px 20px",fontSize:"13px"}}>
                No recordings yet — generate something on the Voice Studio tab!
              </div>
            )}

            {libPageCount>1&&(
              <div className="pg-row">
                <div className="pg-nav" onClick={()=>safeLibPage>0&&setLibPage(p=>Math.max(0,p-1))}><i className="ti ti-arrow-left"/>Prev</div>
                {Array.from({length:libPageCount},(_,i)=>i).slice(0,Math.min(libPageCount,9)).map(i=>(
                  <div key={i} className={`pg${i===safeLibPage?" on":""}`} onClick={()=>setLibPage(i)}>{i+1}</div>
                ))}
                {libPageCount>9&&<div className="pg-dots">···</div>}
                <div className="pg-nav" onClick={()=>safeLibPage<libPageCount-1&&setLibPage(p=>Math.min(libPageCount-1,p+1))}>Next<i className="ti ti-arrow-right"/></div>
                <div className="pg-info">{safeLibPage*PAGE_SIZE+1}–{Math.min((safeLibPage+1)*PAGE_SIZE,filteredFiles.length)} of {filteredFiles.length}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ════════ TAB 2: VOICE LIBRARY ════════ */}
      <div className={`sc${activeTab===2?" a":""}`}>
        <div className="s3body">
          <div className="vlib">
            <div className="vlib-hd">
              <div className="vlib-title">Voice Library — {VOICES.length} voices</div>
              <div className="vlib-close" onClick={()=>setActiveTab(0)}><i className="ti ti-x"/></div>
            </div>
            <div className="vlib-tabs">
              <div className={`vlt${voicePickerTab==="browse"?" a":""}`} onClick={()=>setVoicePickerTab("browse")}>Browse Voices</div>
              <div className={`vlt${voicePickerTab==="train"?" a":""}`} onClick={()=>setVoicePickerTab("train")}>Train Custom Voice</div>
            </div>
            <div className="vlib-body">
              {voicePickerTab==="browse"&&(
                <>
                  <input className="vlib-search" type="text" placeholder="Search name or tone…"
                    value={voiceSearch} onChange={e=>setVoiceSearch(e.target.value)}/>
                  <div className="vfilts">
                    {(["All","Female","Male"] as const).map(g=>(
                      <div key={g} className={`vf${genderFilter===g?" a":""}`} onClick={()=>setGenderFilter(g)}>
                        {g==="Female"&&<i className="ti ti-gender-female"/>}
                        {g==="Male"&&<i className="ti ti-gender-male"/>}
                        {g}
                      </div>
                    ))}
                    <div className={`vf${toneFilter==="All"?" at":""}`} onClick={()=>setToneFilter("All")}>All Tones</div>
                    {(TONE_ORDER as Tone[]).filter(t=>VOICES.some(v=>v.tone===t)).map(t=>(
                      <div key={t} className={`vf${toneFilter===t?" at":""}`} onClick={()=>setToneFilter(t as "All"|Tone)}>{t}</div>
                    ))}
                  </div>
                  <div className="vlib-cnt">{filteredVoices.length} voices</div>
                  {filteredKokoroVoices.length>0&&(
                    <>
                      <div className="prem-row">
                        <span className="prem-lbl">Premium Voices</span>
                        <div className="prem-ln"/>
                      </div>
                      {KOKORO_LANGS.map(lang=>{
                        const langVoices=groupedKokoro[lang];
                        if(!langVoices?.length)return null;
                        const li=KOKORO_LANG_INFO[lang];
                        return(
                          <div key={lang}>
                            <div className="nat-row"><span>{li.flag}</span>{li.label}<div className="nat-hr"/></div>
                            <div className="vc-grid">
                              {langVoices.map((v:VoiceEntry)=>{
                                const vc=v.tone==="Warm"?"amber":v.tone==="Bright"?"teal":v.tone==="Deep"?"purple":"neutral";
                                const sel=voice===v.id;
                                return(
                                  <div key={v.id} className={`vc ${vc}${sel?" sel-active":""}`} onClick={()=>{setVoice(v.id);setActiveTab(0);}}>
                                    <div className="vc-gbg">{v.name.charAt(0)}</div>
                                    <div className="vc-in">
                                      <div className="vc-top">
                                        <div className={`vc-av ${vc}`}>{v.name.charAt(0)}</div>
                                        <div><div className="vc-nm">{v.name}</div><div className="vc-nat">{li.flag} {v.gender}</div></div>
                                      </div>
                                      <span className={`tone ${v.tone.toLowerCase()}`}>{v.tone}</span>
                                      {sel&&<span style={{marginLeft:"6px",fontSize:"10px",color:"var(--acc2)",background:"var(--accg2)",padding:"1px 6px",borderRadius:"4px",fontWeight:600}}>✓ Active</span>}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {filteredClassicVoices.length>0&&(
                    <>
                      {filteredKokoroVoices.length>0&&<div className="nat-row" style={{marginTop:"20px"}}>Classic Voices<div className="nat-hr"/></div>}
                      {(Object.entries(groupedVoices) as [Tone,VoiceEntry[]][]).map(([tone,voices])=>(
                        <div key={tone}>
                          <div className="nat-row">
                            <span style={{color:TONE_CONFIG[tone]?.badge??"var(--t3)"}}>{tone}</span>
                            <div className="nat-hr"/>
                          </div>
                          <div className="vc-grid">
                            {voices.map((v:VoiceEntry)=>{
                              const vc=v.tone==="Warm"?"amber":v.tone==="Bright"?"teal":(v.tone==="Deep"||v.tone==="Custom")?"purple":"neutral";
                              const sel=voice===v.id;
                              return(
                                <div key={v.id} className={`vc ${vc}${sel?" sel-active":""}`} style={{overflow:"visible"}}
                                  onClick={()=>{setVoice(v.id);setActiveTab(0);}}>
                                  <div className="vc-gbg">{v.name.charAt(0)}</div>
                                  <div className="vc-in">
                                    <div className="vc-top">
                                      <div className={`vc-av ${vc}`}>{v.isCustom?"🎤":v.name.charAt(0)}</div>
                                      <div><div className="vc-nm">{v.name}</div><div className="vc-nat">{v.isCustom?"Custom":v.gender}</div></div>
                                    </div>
                                    <span className={`tone ${v.tone.toLowerCase()}`}>{v.isCustom?"Custom":v.tone}</span>
                                    {sel&&<span style={{marginLeft:"6px",fontSize:"10px",color:"var(--acc2)",background:"var(--accg2)",padding:"1px 6px",borderRadius:"4px",fontWeight:600}}>✓ Active</span>}
                                    {v.isCustom&&(
                                      <button onClick={e=>{e.stopPropagation();setDeleteVoiceTarget(v.id);}}
                                        style={{position:"absolute",top:"8px",right:"8px",background:"rgba(248,113,113,.1)",border:"1px solid rgba(248,113,113,.2)",color:"var(--rose)",borderRadius:"5px",cursor:"pointer",fontSize:"10px",padding:"2px 7px",fontFamily:"inherit",zIndex:2}}>✕</button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                  {filteredVoices.length===0&&<div style={{textAlign:"center",color:"var(--t4)",padding:"30px",fontSize:"13px"}}>No voices match your filters</div>}
                </>
              )}

              {voicePickerTab==="train"&&(
                <div>
                  <div style={{background:"var(--accg2)",border:"1px solid rgba(139,124,248,.2)",borderRadius:"var(--r2)",padding:"14px 16px",marginBottom:"20px",fontSize:"12px",color:"var(--t2)",lineHeight:1.6}}>
                    <div style={{fontWeight:600,color:"var(--acc2)",marginBottom:"6px"}}>Zero-Shot Voice Cloning</div>
                    Record <strong style={{color:"var(--t1)"}}>3–10 seconds</strong> of clear speech — clones instantly, <strong style={{color:"var(--t1)"}}>fully offline</strong>.
                  </div>
                  <div style={{marginBottom:"14px"}}>
                    <label style={{fontSize:"10px",color:"var(--t4)",letterSpacing:".16em",textTransform:"uppercase",display:"block",marginBottom:"6px"}}>Voice Name</label>
                    <input type="text" placeholder="e.g. My Voice, John…" value={trainName} onChange={e=>setTrainName(e.target.value)} disabled={training}
                      style={{width:"100%",padding:"10px 12px",background:"var(--s2)",border:"1px solid var(--ln)",borderRadius:"var(--r2)",color:"var(--t1)",fontSize:"13px",fontFamily:"inherit",opacity:training?0.5:1}}/>
                  </div>
                  <div style={{marginBottom:"14px"}}>
                    <label style={{fontSize:"10px",color:"var(--t4)",letterSpacing:".16em",textTransform:"uppercase",display:"block",marginBottom:"6px"}}>Gender</label>
                    <div style={{display:"flex",gap:"8px"}}>
                      {(["Female","Male"] as const).map(g=>(
                        <button key={g} onClick={()=>setTrainGender(g)} disabled={training}
                          style={{flex:1,padding:"8px",borderRadius:"var(--r2)",cursor:training?"not-allowed":"pointer",fontSize:"13px",fontWeight:500,fontFamily:"inherit",
                            background:trainGender===g?"var(--accg)":"var(--s2)",border:trainGender===g?"1px solid rgba(139,124,248,.35)":"1px solid var(--ln)",
                            color:trainGender===g?"var(--acc2)":"var(--t3)",opacity:training?0.5:1}}>{g}</button>
                      ))}
                    </div>
                  </div>
                  <div style={{marginBottom:"18px"}}>
                    <label style={{fontSize:"10px",color:"var(--t4)",letterSpacing:".16em",textTransform:"uppercase",display:"block",marginBottom:"6px"}}>Reference Audio</label>
                    <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
                      <button onClick={pickTrainFile} disabled={training}
                        style={{padding:"9px 14px",borderRadius:"var(--r2)",cursor:training?"not-allowed":"pointer",border:"1px solid var(--ln2)",background:"transparent",color:"var(--t2)",fontSize:"12px",fontFamily:"inherit",whiteSpace:"nowrap",opacity:training?0.5:1}}>
                        Choose File
                      </button>
                      <div style={{flex:1,padding:"9px 12px",background:"var(--s2)",borderRadius:"var(--r2)",border:"1px solid var(--ln)",fontSize:"12px",color:trainFileName?"var(--t1)":"var(--t4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {trainFileName||"No file selected"}
                      </div>
                    </div>
                    <div style={{fontSize:"11px",color:"var(--t4)",marginTop:"5px"}}>WAV, MP3, M4A, OGG, FLAC · Best with 5–10s of clear speech</div>
                  </div>
                  <div style={{marginBottom:"18px"}}>
                    <label style={{fontSize:"10px",color:"var(--t4)",letterSpacing:".16em",textTransform:"uppercase",display:"block",marginBottom:"6px"}}>
                      Transcript <span style={{color:"var(--rose)"}}>*</span>
                    </label>
                    <textarea
                      placeholder="Type exactly what is spoken in the reference audio…"
                      value={trainRefText}
                      onChange={e=>setTrainRefText(e.target.value)}
                      disabled={training}
                      rows={3}
                      style={{width:"100%",padding:"10px 12px",background:"var(--s2)",border:`1px solid ${trainRefText.trim()?"var(--ln)":"rgba(248,113,113,.35)"}`,borderRadius:"var(--r2)",color:"var(--t1)",fontSize:"13px",fontFamily:"inherit",resize:"vertical",opacity:training?0.5:1,boxSizing:"border-box"}}
                    />
                    <div style={{fontSize:"11px",color:"var(--t4)",marginTop:"5px"}}>Required — exact words spoken in the audio improve clone quality</div>
                  </div>
                  <button onClick={startTraining} disabled={training}
                    style={{width:"100%",padding:"12px",borderRadius:"var(--r2)",cursor:training?"not-allowed":"pointer",fontFamily:"inherit",
                      background:training?"var(--accg)":"linear-gradient(135deg,var(--acc),#5b3ee8)",
                      color:"white",border:"none",fontSize:"13px",fontWeight:600,opacity:training?0.8:1}}>
                    {training?"Saving…":"Save Custom Voice"}
                  </button>
                  {training&&(
                    <div style={{marginTop:"16px",background:"var(--s2)",border:"1px solid var(--ln)",borderRadius:"var(--r2)",padding:"14px 16px"}}>
                      <div style={{fontSize:"10px",color:"var(--t4)",letterSpacing:".16em",textTransform:"uppercase",marginBottom:"10px"}}>Progress</div>
                      {TRAIN_STEPS.map((s,i)=>{
                        const done=i<trainStep,active=i===trainStep,pending=i>trainStep;
                        return(
                          <div key={i} style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"8px",opacity:pending?0.35:1}}>
                            <div style={{width:"22px",height:"22px",borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"12px",
                              background:done?"rgba(94,234,212,.1)":active?"var(--accg2)":"var(--s3)",
                              border:`1px solid ${done?"rgba(94,234,212,.3)":active?"rgba(139,124,248,.4)":"var(--ln)"}`}}>
                              {done?"✓":active?<span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span>:s.icon}
                            </div>
                            <span style={{fontSize:"12px",color:done?"var(--mint)":active?"var(--acc2)":"var(--t4)"}}>{s.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {trainStatus&&!training&&(
                    <div style={{marginTop:"14px",padding:"12px 14px",borderRadius:"var(--r2)",fontSize:"12px",lineHeight:1.5,
                      background:trainStatus.startsWith("✓")?"rgba(94,234,212,.08)":trainStatus.startsWith("Error")?"rgba(248,113,113,.08)":"var(--accg2)",
                      color:trainStatus.startsWith("✓")?"var(--mint)":trainStatus.startsWith("Error")?"var(--rose)":"var(--t2)",
                      border:`1px solid ${trainStatus.startsWith("✓")?"rgba(94,234,212,.2)":trainStatus.startsWith("Error")?"rgba(248,113,113,.2)":"rgba(139,124,248,.2)"}`}}>
                      {trainStatus}
                    </div>
                  )}
                  {customVoices.length>0&&(
                    <div style={{marginTop:"24px"}}>
                      <div style={{fontSize:"10px",color:"var(--t4)",textTransform:"uppercase",letterSpacing:".16em",marginBottom:"10px"}}>Trained Voices ({customVoices.length})</div>
                      {customVoices.map(cv=>(
                        <div key={cv.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",background:"var(--s2)",borderRadius:"var(--r2)",border:"1px solid var(--ln)",marginBottom:"6px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
                            <div style={{width:"32px",height:"32px",borderRadius:"50%",background:"var(--accg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"16px"}}>🎤</div>
                            <div>
                              <div style={{fontSize:"13px",color:"var(--t1)",fontWeight:600}}>{cv.name}</div>
                              <div style={{fontSize:"11px",color:"var(--t4)"}}>{cv.gender} · Trained {formatCreated(cv.created)}</div>
                            </div>
                          </div>
                          <div style={{display:"flex",gap:"6px"}}>
                            <button onClick={()=>{setVoice(cv.id);setActiveTab(0);}}
                              style={{padding:"5px 10px",borderRadius:"var(--r1)",cursor:"pointer",background:"var(--accg2)",color:"var(--acc2)",border:"1px solid rgba(139,124,248,.2)",fontSize:"11px",fontFamily:"inherit"}}>Use</button>
                            <button onClick={()=>setDeleteVoiceTarget(cv.id)}
                              style={{padding:"5px 10px",borderRadius:"var(--r1)",cursor:"pointer",background:"rgba(248,113,113,.06)",color:"var(--rose)",border:"1px solid rgba(248,113,113,.15)",fontSize:"11px",fontFamily:"inherit"}}>Delete</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ════════ SETTINGS MODAL ════════ */}
      {settingsOpen&&(
        <div onClick={()=>setSettingsOpen(false)} style={{position:"fixed",inset:0,backgroundColor:"rgba(0,0,0,0.85)",backdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}}>
          <div onClick={e=>e.stopPropagation()} style={{width:"420px",background:"var(--s1)",border:"1px solid var(--ln)",borderRadius:"var(--r4)",boxShadow:"0 32px 64px rgba(0,0,0,0.6)",overflow:"hidden"}}>
            <div style={{padding:"20px 24px",borderBottom:"1px solid var(--ln)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontWeight:600,fontSize:"14px",color:"var(--t1)",fontFamily:"'Outfit',sans-serif"}}>Settings</span>
              <button onClick={()=>setSettingsOpen(false)} style={{background:"none",border:"none",color:"var(--t3)",cursor:"pointer",fontSize:"18px"}}>✕</button>
            </div>
            <div style={{padding:"24px"}}>
              <div style={{marginBottom:"28px"}}>
                <div style={{fontSize:"12px",fontWeight:600,color:"var(--t1)",marginBottom:"4px"}}>Background Brightness</div>
                <div style={{fontSize:"11px",color:"var(--t4)",marginBottom:"14px"}}>Adjust the app's darkness level</div>
                <div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
                  {(Object.entries(BRIGHTNESS) as [BrightnessMode,typeof BRIGHTNESS[BrightnessMode]][]).map(([key,val])=>(
                    <div key={key} onClick={()=>setBrightness(key)}
                      style={{display:"flex",alignItems:"center",gap:"12px",padding:"10px 12px",borderRadius:"var(--r2)",cursor:"pointer",
                        border:brightness===key?"1px solid rgba(139,124,248,.3)":"1px solid var(--ln)",
                        background:brightness===key?"var(--accg2)":"transparent",transition:"all .15s"}}>
                      <div style={{width:"36px",height:"20px",borderRadius:"5px",background:val.bg,border:"1px solid var(--ln)",flexShrink:0}}/>
                      <div style={{flex:1}}>
                        <div style={{fontSize:"13px",color:"var(--t1)",fontWeight:brightness===key?600:400}}>{val.label}</div>
                        <div style={{fontSize:"10px",color:"var(--t4)"}}>{val.bg}</div>
                      </div>
                      {brightness===key&&<span style={{color:"var(--mint)"}}>✓</span>}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{borderTop:"1px solid var(--ln)",paddingTop:"20px"}}>
                <div style={{fontSize:"12px",fontWeight:600,color:"var(--t1)",marginBottom:"4px"}}>Refresh UI</div>
                <div style={{fontSize:"11px",color:"var(--t4)",marginBottom:"12px"}}>Reload audio library and custom voices list</div>
                <button onClick={()=>{setSettingsOpen(false);refreshUI();}}
                  style={{width:"100%",padding:"11px",borderRadius:"var(--r2)",cursor:"pointer",background:"linear-gradient(135deg,var(--acc),#5b3ee8)",color:"white",border:"none",fontSize:"13px",fontWeight:600,fontFamily:"inherit"}}>
                  {refreshing?"Refreshing…":"Refresh Now"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteTarget&&(
        <div style={{position:"fixed",inset:0,backgroundColor:"rgba(0,0,0,0.85)",backdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setDeleteTarget(null)}>
          <div style={{background:"var(--s1)",padding:"28px",borderRadius:"var(--r4)",width:"400px",border:"1px solid var(--ln)",boxShadow:"0 24px 48px rgba(0,0,0,0.5)"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:"14px",fontWeight:600,color:"var(--rose)",marginBottom:"12px"}}>Delete File</div>
            <p style={{color:"var(--t2)",marginBottom:"8px",fontSize:"13px"}}>Delete: <strong style={{color:"var(--t1)",wordBreak:"break-all"}}>{deleteTarget}</strong></p>
            <p style={{color:"var(--rose)",marginBottom:"20px",fontSize:"12px",opacity:0.8}}>This cannot be undone.</p>
            <div style={{display:"flex",gap:"10px",justifyContent:"flex-end"}}>
              <button onClick={()=>setDeleteTarget(null)} style={{padding:"8px 16px",background:"transparent",border:"1px solid var(--ln2)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--t2)",fontSize:"13px",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={confirmDelete} style={{padding:"8px 16px",background:"rgba(248,113,113,.12)",border:"1px solid rgba(248,113,113,.25)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--rose)",fontSize:"13px",fontWeight:600,fontFamily:"inherit"}}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {bulkDeleteConfirm&&(
        <div style={{position:"fixed",inset:0,backgroundColor:"rgba(0,0,0,0.85)",backdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setBulkDeleteConfirm(false)}>
          <div style={{background:"var(--s1)",padding:"28px",borderRadius:"var(--r4)",width:"400px",border:"1px solid var(--ln)",boxShadow:"0 24px 48px rgba(0,0,0,0.5)"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:"14px",fontWeight:600,color:"var(--rose)",marginBottom:"12px"}}>Delete Selected Files</div>
            <p style={{color:"var(--t2)",marginBottom:"8px",fontSize:"13px"}}>Delete <strong style={{color:"var(--t1)"}}>{selectedFiles.size} file{selectedFiles.size!==1?"s":""}</strong>?</p>
            <p style={{color:"var(--rose)",marginBottom:"20px",fontSize:"12px",opacity:0.8}}>This cannot be undone.</p>
            <div style={{display:"flex",gap:"10px",justifyContent:"flex-end"}}>
              <button onClick={()=>setBulkDeleteConfirm(false)} style={{padding:"8px 16px",background:"transparent",border:"1px solid var(--ln2)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--t2)",fontSize:"13px",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={confirmBulkDelete} style={{padding:"8px 16px",background:"rgba(248,113,113,.12)",border:"1px solid rgba(248,113,113,.25)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--rose)",fontSize:"13px",fontWeight:600,fontFamily:"inherit"}}>Delete {selectedFiles.size}</button>
            </div>
          </div>
        </div>
      )}

      {deleteAllConfirm&&(
        <div style={{position:"fixed",inset:0,backgroundColor:"rgba(0,0,0,0.85)",backdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setDeleteAllConfirm(false)}>
          <div style={{background:"var(--s1)",padding:"28px",borderRadius:"var(--r4)",width:"400px",border:"1px solid var(--ln)",boxShadow:"0 24px 48px rgba(0,0,0,0.5)"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:"14px",fontWeight:600,color:"var(--rose)",marginBottom:"12px"}}>Delete All Recordings</div>
            <p style={{color:"var(--t2)",marginBottom:"8px",fontSize:"13px"}}>Delete <strong style={{color:"var(--t1)"}}>all {audioFiles.length} recording{audioFiles.length!==1?"s":""}</strong>?</p>
            <p style={{color:"var(--rose)",marginBottom:"20px",fontSize:"12px",opacity:0.8}}>This cannot be undone.</p>
            <div style={{display:"flex",gap:"10px",justifyContent:"flex-end"}}>
              <button onClick={()=>setDeleteAllConfirm(false)} style={{padding:"8px 16px",background:"transparent",border:"1px solid var(--ln2)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--t2)",fontSize:"13px",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={confirmDeleteAll} style={{padding:"8px 16px",background:"rgba(248,113,113,.12)",border:"1px solid rgba(248,113,113,.25)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--rose)",fontSize:"13px",fontWeight:600,fontFamily:"inherit"}}>Delete All</button>
            </div>
          </div>
        </div>
      )}

      {deleteVoiceTarget&&(
        <div style={{position:"fixed",inset:0,backgroundColor:"rgba(0,0,0,0.85)",backdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:4000}} onClick={()=>setDeleteVoiceTarget(null)}>
          <div style={{background:"var(--s1)",padding:"28px",borderRadius:"var(--r4)",width:"400px",border:"1px solid var(--ln)",boxShadow:"0 24px 48px rgba(0,0,0,0.5)"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:"14px",fontWeight:600,color:"var(--rose)",marginBottom:"12px"}}>Delete Custom Voice</div>
            <p style={{color:"var(--t2)",marginBottom:"8px",fontSize:"13px"}}>This will permanently delete the trained voice and its embedding file.</p>
            <p style={{color:"var(--rose)",marginBottom:"20px",fontSize:"12px",opacity:0.8}}>This cannot be undone.</p>
            <div style={{display:"flex",gap:"10px",justifyContent:"flex-end"}}>
              <button onClick={()=>setDeleteVoiceTarget(null)} style={{padding:"8px 16px",background:"transparent",border:"1px solid var(--ln2)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--t2)",fontSize:"13px",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={confirmDeleteVoice} style={{padding:"8px 16px",background:"rgba(248,113,113,.12)",border:"1px solid rgba(248,113,113,.25)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--rose)",fontSize:"13px",fontWeight:600,fontFamily:"inherit"}}>Delete Voice</button>
            </div>
          </div>
        </div>
      )}

      {renameTarget&&(
        <div style={{position:"fixed",inset:0,backgroundColor:"rgba(0,0,0,0.85)",backdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setRenameTarget(null)}>
          <div style={{background:"var(--s1)",padding:"28px",borderRadius:"var(--r4)",width:"400px",border:"1px solid var(--ln)",boxShadow:"0 24px 48px rgba(0,0,0,0.5)"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:"14px",fontWeight:600,color:"var(--t1)",marginBottom:"12px"}}>Rename File</div>
            <p style={{color:"var(--t2)",marginBottom:"16px",fontSize:"13px"}}>Renaming: <strong style={{color:"var(--t1)"}}>{renameTarget}</strong></p>
            <input autoFocus type="text" value={renameValue} onChange={e=>setRenameValue(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter")confirmRename();if(e.key==="Escape")setRenameTarget(null);}}
              style={{width:"100%",padding:"10px 12px",borderRadius:"var(--r2)",background:"var(--s2)",color:"var(--t1)",border:"1px solid var(--ln)",marginBottom:"16px",boxSizing:"border-box",fontSize:"13px",fontFamily:"inherit"}}/>
            <div style={{display:"flex",gap:"10px",justifyContent:"flex-end"}}>
              <button onClick={()=>setRenameTarget(null)} style={{padding:"8px 16px",background:"transparent",border:"1px solid var(--ln2)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--t2)",fontSize:"13px",fontFamily:"inherit"}}>Cancel</button>
              <button onClick={confirmRename} style={{padding:"8px 16px",background:"var(--accg2)",border:"1px solid rgba(139,124,248,.25)",borderRadius:"var(--r2)",cursor:"pointer",color:"var(--acc2)",fontSize:"13px",fontWeight:600,fontFamily:"inherit"}}>Rename</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
