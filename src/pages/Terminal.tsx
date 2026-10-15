import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import "../css/terminal.css";
import { BUILTIN_NAMES } from "../lib/commands";
import { Block, Line, useTerminal } from "../hooks/useTerminal";
import { copyText } from "../lib/native";
import { SHELL_NAME } from "../lib/shell";


/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
 
/** ~/projects/app instead of C:\Users\me\projects\app, and at most three segments. */
function shortenPath(path: string, home: string): string {
  if (!path) return "...";
  const sep = path.includes("\\") ? "\\" : "/";
  let p = path;
  if (home && p.toLowerCase().startsWith(home.toLowerCase())) p = "~" + p.slice(home.length);
  const parts = p.split(sep).filter(Boolean);
  return parts.length > 3 ? `...${sep}${parts.slice(-3).join(sep)}` : p;
}
 
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}
 
/** PowerShell pads its output with empty lines; drop them at both ends. */
function trimBlank(lines: Line[]): Line[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].text.trim() === "") start++;
  while (end > start && lines[end - 1].text.trim() === "") end--;
  return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}
 
/** Completes built-in command names: unique match, or the longest shared prefix. */
function complete(value: string): string | null {
  if (!value || value.includes(" ")) return null;
  const hits = BUILTIN_NAMES.filter((n) => n.startsWith(value));
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0] + " ";
  let prefix = hits[0];
  for (const hit of hits) while (!hit.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix.length > value.length ? prefix : null;
}
 
/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */
 
function Status({ block }: { block: Block }) {
  switch (block.status) {
    case "running":
      return (
        <span className="tm-status tm-status--running">
          <span className="tm-spin" aria-hidden="true" /> running
        </span>
      );
    case "ok":
      return <span className="tm-status tm-status--ok">✓ {formatDuration(block.durationMs ?? 0)}</span>;
    case "error":
      return <span className="tm-status tm-status--error">✕ {formatDuration(block.durationMs ?? 0)}</span>;
    case "killed":
      return <span className="tm-status tm-status--killed">■ stopped</span>;
  }
}
 
const BlockView = memo(function BlockView({ block, home }: { block: Block; home: string }) {
  const [copied, setCopied] = useState(false);
  const lines = trimBlank(block.lines);
 
  const copy = () =>
    copyText(lines.map((l) => l.text).join("\n"))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
 
  return (
    <article className="tm-block" data-status={block.status}>
      <header className="tm-block-head">
        <span className="tm-block-cwd">{shortenPath(block.cwd, home)}</span>
        <span className="tm-chev" aria-hidden="true">❯</span>
        <code className="tm-block-cmd">{block.command}</code>
        <span className="tm-block-meta">
          {lines.length > 0 && (
            <button type="button" className="tm-ghost tm-copy" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          <Status block={block} />
        </span>
      </header>
      {lines.length > 0 && (
        <pre className="tm-out">
          {lines.map((l, i) => (
            <span key={i} className={`tm-l tm-l--${l.kind}`}>
              {l.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </article>
  );
});
 
function Welcome({ onRun }: { onRun: (command: string) => void }) {
  return (
    <div className="tm-welcome">
      <div className="tm-welcome-title">rusty-hermes terminal</div>
      <div className="tm-welcome-sub">
        Real {SHELL_NAME} commands, plus a few built-ins. Output stays above, you type below.
      </div>
      <div className="tm-quick">
        {["help", "about", "cli", "ls"].map((c) => (
          <button key={c} type="button" className="tm-ghost" onClick={() => onRun(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="tm-keys">
        <span><kbd className="tm-key">↑</kbd> <kbd className="tm-key">↓</kbd> history</span>
        <span><kbd className="tm-key">Tab</kbd> complete</span>
        <span><kbd className="tm-key">Ctrl</kbd> <kbd className="tm-key">C</kbd> stop</span>
        <span><kbd className="tm-key">Ctrl</kbd> <kbd className="tm-key">L</kbd> clear</span>
      </div>
    </div>
  );
}
 
/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */
 
export function Terminal() {
  const t = useTerminal();
  const running = t.runningId !== null;
 
  const [value, setValue] = useState("");
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draft = useRef("");
 
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);
 
  // Focus the input as soon as the working directory is known.
  useEffect(() => {
    if (t.cwd) inputRef.current?.focus();
  }, [t.cwd]);
 
  // Keep the view pinned to the newest output, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [t.blocks]);
 
  const onScroll = () => {
    const el = outputRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    stuckRef.current = atBottom;
    setStuck(atBottom);
  };
 
  const jumpToLatest = () => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
 
  const run = (command: string) => {
    stuckRef.current = true;
    setHistoryIndex(null);
    void t.submit(command);
    inputRef.current?.focus();
  };
 
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
 
    if (e.key === "Enter") {
      run(value);
      setValue("");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (t.history.length === 0) return;
      if (historyIndex === null) draft.current = value;
      const next = historyIndex === null ? t.history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setValue(t.history[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= t.history.length) {
        setHistoryIndex(null);
        setValue(draft.current);
      } else {
        setHistoryIndex(next);
        setValue(t.history[next]);
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const completed = complete(value);
      if (completed) setValue(completed);
    } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
      // Let Ctrl+C copy when text in the input is selected.
      if (input.selectionStart !== input.selectionEnd) return;
      e.preventDefault();
      if (!t.interrupt()) setValue("");
    } else if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      t.clear();
    }
  };
 
  return (
    <main className="tm-page">
      <section className="tm-shell">
        <header className="tm-bar">
          <span className="tm-title">
            <span className="tm-dot" data-busy={running} aria-hidden="true" />
            Terminal
          </span>
          <span className="tm-chip">{SHELL_NAME}</span>
          <span className="tm-chip tm-chip--path" title={t.cwd}>
            {shortenPath(t.cwd, t.home)}
          </span>
          <span className="tm-spacer" />
          <button type="button" className="tm-ghost" onClick={t.clear} title="Clear (Ctrl+L)">
            Clear
          </button>
        </header>
 
        <div className="tm-output-wrap">
          <div
            ref={outputRef}
            className="tm-output"
            role="log"
            aria-label="Terminal output"
            onScroll={onScroll}
            onClick={() => {
              if (!window.getSelection()?.toString()) inputRef.current?.focus();
            }}
          >
            {t.blocks.length === 0 && <Welcome onRun={run} />}
            {t.blocks.map((b) => (
              <BlockView key={b.id} block={b} home={t.home} />
            ))}
          </div>
          {!stuck && (
            <button type="button" className="tm-ghost tm-jump" onClick={jumpToLatest}>
              ↓ Latest
            </button>
          )}
        </div>
 
        <div className="tm-input-row">
          <span className="tm-prompt" title={t.cwd}>
            {running ? "stdin" : shortenPath(t.cwd, t.home)}
          </span>
          <span className="tm-chev" aria-hidden="true">❯</span>
          <input
            ref={inputRef}
            className="tm-input"
            value={value}
            disabled={!t.cwd}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            placeholder={running ? "Sent to the running process. Ctrl+C to stop." : "Type a command"}
            aria-label="Terminal input"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </section>
    </main>
  );
}
 