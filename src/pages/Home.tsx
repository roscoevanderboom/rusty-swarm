// Home.tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { LuFolderOpen, LuNotebookPen, LuSquareTerminal, LuKanban, LuNetwork, LuActivity } from "react-icons/lu";

const APPS = [
  { id: "explorer", label: "File Explorer", Icon: LuFolderOpen,      path: "/explorer" },
  { id: "terminal", label: "Terminal",       Icon: LuSquareTerminal,  path: "/terminal" },
  { id: "notepad",  label: "Notepad",        Icon: LuNotebookPen,     path: "/notepad"  },
  { id: "kanban",   label: "Task Board",     Icon: LuKanban,          path: "/kanban"   },
  { id: "http",     label: "HTTP Client",    Icon: LuNetwork,         path: "/http"     },
  { id: "monitor",  label: "System Monitor", Icon: LuActivity,        path: "/monitor"  },
];

export function Home() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const navigate = useNavigate();

  async function greet() {
    setGreetMsg(await invoke("greet", { name }));
  }

  return (
    <main className="container">
      <h1>Welcome to Tauri + React</h1>
      <div className="greet-section" style={{width:'100%',maxWidth:'450px',display:'flex',flexDirection:'column',alignItems:'center'}}>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            greet();
          }}
        >
          <input
            id="greet-input"
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="Enter a name..."
          />
          <button type="submit">Greet</button>
        </form>
        <div className="greet-response" style={{marginTop:'1rem'}}>
          {greetMsg && <p>{greetMsg}</p>}
        </div>
      </div>
      <nav className="app-icons" aria-label="Apps" style={{position:'absolute',top:260,left:'50%',transform:'translateX(-50%)',display:'flex',flexWrap:'wrap',justifyContent:'center',gap:'16px'}}>
        {APPS.map(({ id, label, Icon, path }) => (
          <button
            key={id}
            type="button"
            className="app-icon"
            title={label}
            onClick={() => navigate(path)}
          >
            <span className="app-icon-glyph">
              <Icon size={34} aria-hidden="true" />
            </span>
            <span className="app-icon-label">{label}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}