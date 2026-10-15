import { isTauri } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useRef, useState } from "react";
import { RunningProcess, spawnShell, stripAnsi, IS_WINDOWS } from "../lib/shell";
import { errorMessage } from "../lib/native";
import { BUILTINS } from "../lib/commands";


export type LineKind = "stdout" | "stderr" | "stdin" | "info";
export type BlockStatus = "running" | "ok" | "error" | "killed";
 
export interface Line {
  kind: LineKind;
  text: string;
}
 
/** One command and its output, shown as a unit. */
export interface Block {
  id: number;
  cwd: string;
  command: string;
  lines: Line[];
  status: BlockStatus;
  startedAt: number;
  durationMs?: number;
  truncated?: boolean;
}
 
const MAX_BLOCKS = 200;
const MAX_LINES = 5000;
const FLUSH_MS = 50;
 
const toLines = (kind: LineKind, text: string): Line[] =>
  stripAnsi(text)
    .replace(/\r/g, "")
    .split("\n")
    .map((t) => ({ kind, text: t }));
 
function shellHelp(e: unknown) {
  const message = errorMessage(e);
  return /scope|not allowed|permission/i.test(message)
    ? `${message}\nThe shell isn't allowed by this app's capabilities. Add src-tauri/capabilities/terminal.json.`
    : message;
}
 
export function useTerminal() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [cwd, setCwd] = useState("");
  const [home, setHome] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [runningId, setRunningId] = useState<number | null>(null);
 
  const nextId = useRef(1);
  const proc = useRef<{ id: number; handle: RunningProcess } | null>(null);
 
  // Start in the home directory.
  useEffect(() => {
    (async () => {
      const dir = isTauri() ? await homeDir().catch(() => "~") : "~";
      setHome(dir);
      setCwd(dir);
    })();
  }, []);
 
  // Don't leave a process running if the page is closed.
  useEffect(() => () => void proc.current?.handle.kill().catch(() => {}), []);
 
  const patch = useCallback((id: number, fn: (b: Block) => Block) => {
    setBlocks((all) => all.map((b) => (b.id === id ? fn(b) : b)));
  }, []);
 
  const append = useCallback(
    (id: number, lines: Line[]) =>
      patch(id, (b) => {
        if (b.truncated) return b;
        const room = MAX_LINES - b.lines.length;
        if (lines.length <= room) return { ...b, lines: [...b.lines, ...lines] };
        return {
          ...b,
          truncated: true,
          lines: [
            ...b.lines,
            ...lines.slice(0, Math.max(room, 0)),
            { kind: "info", text: `... output truncated after ${MAX_LINES} lines` },
          ],
        };
      }),
    [patch],
  );
 
  const submit = useCallback(
    async (raw: string) => {
      // While a process runs, input goes to its stdin instead of starting a new command.
      if (proc.current) {
        const { id, handle } = proc.current;
        append(id, [{ kind: "stdin", text: raw }]);
        await handle.write(raw + "\n").catch((e) => append(id, toLines("stderr", errorMessage(e))));
        return;
      }
 
      const line = raw.trim();
      if (!line || !cwd) return;
 
      setHistory((h) => (h[h.length - 1] === line ? h : [...h, line]));
 
      const id = nextId.current++;
      const startedAt = Date.now();
      setBlocks((all) =>
        [...all, { id, cwd, command: line, lines: [], status: "running" as const, startedAt }].slice(-MAX_BLOCKS),
      );
      const finish = (status: BlockStatus) =>
        patch(id, (b) => ({ ...b, status, durationMs: Date.now() - b.startedAt }));
 
      // On Windows, typing `d:` switches drive. Treat it as a cd so the prompt follows.
      const driveSwitch = IS_WINDOWS && /^[a-z]:$/i.test(line);
      const [name, ...args] = driveSwitch ? ["cd", `${line}\\`] : line.split(/\s+/);
      const rest = driveSwitch ? `${line}\\` : line.slice(name.length).trim();
      const builtin = BUILTINS[name];
 
      if (builtin) {
        let failed = false;
        try {
          await builtin.run({
            args,
            rest,
            cwd,
            home,
            history: [...history, line],
            print: (text) => append(id, toLines("stdout", text)),
            error: (text) => {
              failed = true;
              append(id, toLines("stderr", text));
            },
            clear: () => setBlocks([]),
            setCwd,
          });
        } catch (e) {
          failed = true;
          append(id, toLines("stderr", errorMessage(e)));
        }
        finish(failed ? "error" : "ok");
        return;
      }
 
      // Not a built-in: run it in the real shell and stream the output.
      // Output is buffered briefly so a flood of lines doesn't re-render on every one.
      let pending: Line[] = [];
      let timer: number | undefined;
      let exited = false;
 
      const flush = () => {
        timer = undefined;
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        append(id, batch);
      };
      const push = (kind: LineKind, text: string) => {
        pending.push(...toLines(kind, text.replace(/\r?\n$/, "")));
        timer ??= window.setTimeout(flush, FLUSH_MS);
      };
 
      try {
        const handle = await spawnShell(line, cwd, {
          onLine: push,
          onExit: (code, killed) => {
            exited = true;
            window.clearTimeout(timer);
            flush();
            proc.current = null;
            setRunningId(null);
            if (code !== null && code !== 0 && !killed) append(id, [{ kind: "info", text: `exit code ${code}` }]);
            finish(killed ? "killed" : code === 0 ? "ok" : "error");
          },
        });
        if (!exited) {
          proc.current = { id, handle };
          setRunningId(id);
        }
      } catch (e) {
        append(id, toLines("stderr", shellHelp(e)));
        finish("error");
      }
    },
    [cwd, home, history, append, patch],
  );
 
  /** Ctrl+C. Returns false when there was nothing to stop. */
  const interrupt = useCallback(() => {
    if (!proc.current) return false;
    void proc.current.handle.kill().catch(() => {});
    return true;
  }, []);
 
  const clear = useCallback(() => setBlocks([]), []);
 
  return { blocks, cwd, home, history, runningId, submit, interrupt, clear };
}
 