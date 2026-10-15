import { useCallback, useState, useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Home } from "./pages/Home";
import { FileExplorer } from "./pages/FileExplorer";
import { Terminal } from "./pages/Terminal";
import { Notepad } from "./pages/Notepad";
import { Kanban } from "./pages/Kanban";
import { HttpClient } from "./pages/HttpClient";
import { SystemMonitor } from "./pages/SystemMonitor";
import { useApiServer, useLogs, useSettings, useSettingsEffects } from "./hooks";
import { SettingsModal } from "./components/SettingsModal";
import { TitleBar } from "./components/TitleBar";
import { getPlatform } from "./lib/native";

const platform = getPlatform();
// Mark the document so CSS can adapt layout to whether the custom titlebar is present.
document.documentElement.dataset.platform = platform;

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Mounted here, not in the modal, so settings keep working while it's closed.
  const { settings, setSetting, applySettings, resetSettings, ready } = useSettings();
  const { errors } = useSettingsEffects(settings, ready);
  const server = useApiServer(settings, ready);
  const { logs, clearLogs } = useLogs();

  // Open settings with Ctrl+, / Cmd+, on macOS and Linux (no titlebar gear).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div>
      {/* Custom titlebar: Windows-only (decorations: false).
          On macOS and Linux the native window chrome is used (decorations: true).
          On those platforms, open settings with Ctrl+, / Cmd+,. */}
      {(platform === "windows" || platform === "browser") && (
        <TitleBar closeToTray={settings.closeToTray} onOpenSettings={() => setSettingsOpen(true)} />
      )}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/explorer" element={<FileExplorer />} />
        <Route path="/terminal" element={<Terminal />} />
        <Route path="/notepad" element={<Notepad />} />
        <Route path="/kanban" element={<Kanban />} />
        <Route path="/http" element={<HttpClient />} />
        <Route path="/monitor" element={<SystemMonitor />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {settingsOpen && (
        <SettingsModal
          onClose={closeSettings}
          settings={settings}
          setSetting={setSetting}
          applySettings={applySettings}
          resetSettings={resetSettings}
          logs={logs}
          clearLogs={clearLogs}
          server={server}
          effectErrors={errors}
        />
      )}
    </div>
  );
}

export default App;
