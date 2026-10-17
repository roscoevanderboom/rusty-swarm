import { useCallback, useState, useEffect } from "react";
import { Home } from "./pages/Home";
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

  // Keep the keyboard shortcut available alongside the visible Settings button.
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
        {/* Windows uses custom window chrome; Linux keeps native decorations and
          gets an in-app toolbar for settings. */}
      {(platform === "windows" || platform === "linux" || platform === "browser") && (
        <TitleBar closeToTray={settings.closeToTray} onOpenSettings={() => setSettingsOpen(true)} />
      )}
      <Home />
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
