/**
 * Everything that touches tauri-plugin-shell lives here.
 *
 * The program names ("powershell", "sh") are not free text: the shell plugin only
 * runs commands that are listed in src-tauri/capabilities/terminal.json, so this
 * file and that one have to agree.
 */
import { isTauri } from "@tauri-apps/api/core";
import { Command, type Child } from "@tauri-apps/plugin-shell";

export const IS_WINDOWS = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
export const SHELL_NAME = IS_WINDOWS ? "PowerShell" : "sh";

const PROGRAM = IS_WINDOWS ? "powershell" : "sh";

function argsFor(line: string): string[] {
  return IS_WINDOWS
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // PowerShell defaults to the OEM code page, which garbles non-ASCII output.
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${line}`,
      ]
    : ["-c", line];
}

/** Removes ANSI escape sequences (colors, cursor moves) that a plain text view can't render. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export interface RunHandlers {
  onLine(kind: "stdout" | "stderr", text: string): void;
  onExit(code: number | null, killed: boolean): void;
}

export interface RunningProcess {
  kill(): Promise<void>;
  write(text: string): Promise<void>;
}

/** Starts a command and streams its output line by line. Resolves once the process has spawned. */
export async function spawnShell(line: string, cwd: string, handlers: RunHandlers): Promise<RunningProcess> {
  if (!isTauri()) throw new Error("The shell only runs in the desktop app.");

  const command = Command.create(PROGRAM, argsFor(line), { cwd });
  let killed = false;

  command.stdout.on("data", (text) => handlers.onLine("stdout", text));
  command.stderr.on("data", (text) => handlers.onLine("stderr", text));
  command.on("error", (message) => handlers.onLine("stderr", message));
  command.on("close", ({ code }) => handlers.onExit(code, killed));

  const child: Child = await command.spawn();
  return {
    kill: async () => {
      killed = true;
      await child.kill();
    },
    write: (text) => child.write(text),
  };
}

/**
 * `cd` can't persist between commands, because every command is its own process.
 * So the terminal keeps the working directory itself and asks the shell to resolve
 * the new path, which gives us ~, .., relative paths and errors for free.
 */
export async function resolveCd(
  rest: string,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  if (!isTauri()) return { ok: false, error: "The shell only runs in the desktop app." };

  const line = IS_WINDOWS
    ? `$ErrorActionPreference='Stop'; Set-Location ${rest || "~"}; (Get-Location).Path`
    : `cd ${rest} && pwd`;
  const result = await Command.create(PROGRAM, argsFor(line), { cwd }).execute();

  if (result.code !== 0) {
    return { ok: false, error: stripAnsi(result.stderr || result.stdout).trim() || `cd: ${rest}: no such directory` };
  }
  const next = result.stdout.trim().split(/\r?\n/).pop();
  return next ? { ok: true, cwd: next } : { ok: false, error: "cd: couldn't resolve that path" };
}
