import "./App.css";

function App() {
  return (
    <div className="container">
      <h1>VoiceAI</h1>

      <label>Script</label>

      <textarea
        placeholder="Enter your script here..."
        rows={12}
      />

      <label>Voice</label>

      <select>
        <option>Kai</option>
        <option>Emma</option>
        <option>Narrator</option>
      </select>

      <button>
        Generate Voice
      </button>

      <p>Status: Ready</p>
    </div>
  );
}

export default App;
