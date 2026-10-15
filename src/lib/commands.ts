/**
 * Built-in commands. Anything not listed here is sent to the real shell.
 *
 * To add a command, add an entry to BUILTINS. It gets a context for printing
 * output and reading or changing the working directory.
 */
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { getMatches } from "@tauri-apps/plugin-cli";
import { invoke } from "@tauri-apps/api/core";
import { IS_WINDOWS, SHELL_NAME, resolveCd } from "./shell";
import { errorMessage, getAppInfo } from "./native";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommandContext {
  /** Arguments split on whitespace. */
  args: string[];
  /** Everything after the command name, unsplit. */
  rest: string;
  cwd: string;
  home: string;
  history: string[];
  print(text: string): void;
  /** Prints in the error color and marks the command as failed. */
  error(text: string): void;
  clear(): void;
  setCwd(cwd: string): void;
}

export interface BuiltIn {
  description: string;
  run(ctx: CommandContext): void | Promise<void>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OS_NAME = IS_WINDOWS ? "Windows" : /Mac/i.test(navigator.platform) ? "macOS" : "Linux";

// ── ls / dir helper ───────────────────────────────────────────────────────────

interface DirEntry {
  name: string;
  isDir: boolean;
  size?: number;
  modified?: number; // unix seconds
  ext?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatModified(ts?: number): string {
  if (!ts) return " ".repeat(16);
  const d = new Date(ts * 1000);
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} ${time}`;
}

async function runLs(ctx: CommandContext) {
  const { cwd, rest, print, error } = ctx;
  const target = rest.trim() || cwd;

  let entries: DirEntry[];
  try {
    entries = await invoke<DirEntry[]>("explorer_list_dir", { path: target });
  } catch (e) {
    error(errorMessage(e));
    return;
  }

  if (entries.length === 0) {
    print("(empty)");
    return;
  }

  const dirs  = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  const maxName = Math.max(...entries.map((e) => e.name.length + (e.isDir ? 1 : 0)), 4);
  const maxSize = Math.max(...files.map((e) => formatSize(e.size ?? 0).length), 4);
  const modLen  = 16; // "MM/DD/YYYY HH:MM"

  print(`${"Name".padEnd(maxName)}  ${"Modified".padEnd(modLen)}  ${"Size".padStart(maxSize)}`);
  print(`${"─".repeat(maxName)}  ${"─".repeat(modLen)}  ${"─".repeat(maxSize)}`);

  const row = (e: DirEntry) => {
    const name = e.isDir ? `${e.name}/` : e.name;
    const mod  = formatModified(e.modified);
    const size = e.isDir ? "" : formatSize(e.size ?? 0);
    return `${name.padEnd(maxName)}  ${mod}  ${size.padStart(maxSize)}`;
  };

  for (const e of dirs)  print(row(e));
  for (const e of files) print(row(e));
  print("");
  print(`  ${dirs.length} folder${dirs.length !== 1 ? "s" : ""},  ${files.length} file${files.length !== 1 ? "s" : ""}`);
}

// ── Built-ins ─────────────────────────────────────────────────────────────────

export const BUILTINS: Record<string, BuiltIn> = {
  help: {
    description: "List the built-in commands",
    run({ print }) {
      for (const [name, b] of Object.entries(BUILTINS)) print(`${name.padEnd(10)} ${b.description}`);
      print("");
      print(`Anything else runs in ${SHELL_NAME}.`);
    },
  },

  clear: {
    description: "Clear the screen (Ctrl+L)",
    run: ({ clear }) => clear(),
  },

  cd: {
    description: "Change directory",
    async run({ rest, cwd, setCwd, error }) {
      const result = await resolveCd(rest, cwd);
      if (result.ok) setCwd(result.cwd);
      else error(result.error);
    },
  },

  pwd: {
    description: "Print the working directory",
    run: ({ cwd, print }) => print(cwd),
  },

  ls: {
    description: "List directory contents",
    run: runLs,
  },

  dir: {
    description: "List directory contents (alias for ls)",
    run: runLs,
  },

  ll: {
    description: "List directory contents (alias for ls)",
    run: runLs,
  },

  echo: {
    description: "Print text",
    run: ({ rest, print }) => print(rest),
  },

  date: {
    description: "Print the current date and time",
    run: ({ print }) => print(new Date().toString()),
  },

  history: {
    description: "Show command history",
    run: ({ history, print }) => history.forEach((c, i) => print(`${String(i + 1).padStart(4)}  ${c}`)),
  },

  about: {
    description: "Show app and system info",
    async run({ print }) {
      const info = await getAppInfo();
      print(`rusty-hermes  ${info.version}`);
      print(`tauri         ${info.tauri}`);
      print(`system        ${OS_NAME}`);
      print(`shell         ${SHELL_NAME}`);
    },
  },

  cli: {
    description: "Show the arguments the app was launched with",
    async run({ print, error }) {
      try {
        const matches = await getMatches();
        const entries = Object.entries(matches.args);
        if (entries.length === 0 && !matches.subcommand) {
          print("No arguments were passed.");
          return;
        }
        for (const [name, arg] of entries) {
          const times = arg.occurrences > 1 ? `  (x${arg.occurrences})` : "";
          print(`${name} = ${JSON.stringify(arg.value)}${times}`);
        }
        if (matches.subcommand) print(`subcommand: ${matches.subcommand.name}`);
      } catch (e) {
        error(`${errorMessage(e)}\nDeclare the accepted arguments under "plugins.cli" in tauri.conf.json.`);
      }
    },
  },

  relaunch: {
    description: "Restart the app",
    run: () => relaunch(),
  },

  exit: {
    description: "Quit the app",
    run: () => exit(0),
  },
};

export const BUILTIN_NAMES = Object.keys(BUILTINS);
