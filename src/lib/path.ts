export type PathPlatform = "win32" | "linux";

export function detectPathPlatform(userAgent?: string): PathPlatform {
  const ua = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  return ua.includes("Windows") ? "win32" : "linux";
}

export function normalizePath(input: string, platform: PathPlatform = detectPathPlatform()): string {
  if (!input) return "";

  if (platform === "linux") {
    let value = input.replace(/\\/g, "/");
    value = value.replace(/\/+/g, "/");
    if (value === "") return "/";
    if (value === "/") return "/";
    return value.replace(/\/+$/, "") || "/";
  }

  let value = input.replace(/\//g, "\\");
  value = value.replace(/\\+/g, "\\");
  if (/^[A-Za-z]:$/.test(value)) return `${value}\\`;
  if (/^[A-Za-z]:\\?$/.test(value)) return value.replace(/\\?$/, "\\");
  if (value.endsWith("\\") && !/^[A-Za-z]:\\$/.test(value)) {
    value = value.slice(0, -1);
  }
  return value;
}

export function joinPath(base: string, name: string, platform: PathPlatform = detectPathPlatform()): string {
  const root = normalizePath(base, platform);
  const cleanName = normalizePath(name, platform);

  if (!root) return cleanName;

  if (platform === "linux") {
    if (root === "/") return `/${cleanName.replace(/^\//, "")}`.replace(/\/+/g, "/");
    return `${root.replace(/\/+$/, "")}/${cleanName.replace(/^\//, "")}`.replace(/\/+/g, "/");
  }

  if (/^[A-Za-z]:\\$/.test(root)) return `${root}${cleanName.replace(/^\\+/, "")}`;
  if (root.endsWith("\\")) return `${root}${cleanName.replace(/^\\+/, "")}`;
  return `${root}\\${cleanName.replace(/^\\+/, "")}`;
}

export function parentPath(input: string, platform: PathPlatform = detectPathPlatform()): string | null {
  const value = normalizePath(input, platform);

  if (platform === "linux") {
    if (value === "/") return null;
    const trimmed = value.replace(/\/+$/, "") || "/";
    if (trimmed === "/") return null;
    const idx = trimmed.lastIndexOf("/");
    if (idx <= 0) return "/";
    return trimmed.slice(0, idx) || "/";
  }

  if (!value || /^[A-Za-z]:\\?$/.test(value)) return null;
  const trimmed = value.replace(/\\+$/, "");
  const idx = trimmed.lastIndexOf("\\");
  if (idx <= 2) return /^[A-Za-z]:$/.test(trimmed.slice(0, idx + 1)) ? `${trimmed.slice(0, idx + 1)}\\` : null;
  return trimmed.slice(0, idx) || null;
}

export function pathSegments(input: string, platform: PathPlatform = detectPathPlatform()): Array<{ label: string; path: string }> {
  const value = normalizePath(input, platform);

  if (!value) return [];

  if (platform === "linux") {
    if (value === "/") return [{ label: "/", path: "/" }];
    const parts = value.split("/").filter(Boolean);
    let current = "";
    const result: Array<{ label: string; path: string }> = [];
    for (const part of parts) {
      current = current ? `${current}/${part}` : `/${part}`;
      result.push({ label: part, path: current });
    }
    return [{ label: "/", path: "/" }, ...result];
  }

  const driveMatch = value.match(/^([A-Za-z]:\\)/);
  const root = driveMatch ? driveMatch[1] : "";
  const rest = root ? value.slice(root.length) : value;
  const parts = rest.split("\\").filter(Boolean);
  const result: Array<{ label: string; path: string }> = [];

  if (root) {
    result.push({ label: root, path: root });
  }

  let current = root;
  for (const part of parts) {
    current = current ? `${current}${part}\\` : `${part}\\`;
    result.push({ label: part, path: current.replace(/\\$/, "") });
  }

  return result.length ? result : [{ label: value, path: value }];
}
