import { useCallback, useEffect, useRef, useState } from "react";
import { httpGet } from "../lib/http";
import { copyText, errorMessage } from "../lib/native";
import {
  LuGlobe,
  LuLoaderCircle,
  LuSearch,
  LuCopy,
  LuX,
  LuSparkles,
  LuSkull,
  LuSwords,
  LuShield,
  LuUsers,
  LuFlame,
  LuPuzzle,
  LuGraduationCap,
  LuImage,
} from "react-icons/lu";
import "../css/http-client.css";

// ── D&D 5e SRD API ───────────────────────────────────────────────────────────
// Public, no auth, GET only. The /api prefix 301-redirects to /api/2014.

const BASE = "https://www.dnd5eapi.co/api/2014";
const IMAGE_BASE = "https://www.dnd5eapi.co";

interface Resource {
  id: string;
  label: string;
  Icon: typeof LuSparkles;
}

const RESOURCES: Resource[] = [
  { id: "spells", label: "Spells", Icon: LuSparkles },
  { id: "monsters", label: "Monsters", Icon: LuSkull },
  { id: "equipment", label: "Equipment", Icon: LuSwords },
  { id: "classes", label: "Classes", Icon: LuShield },
  { id: "races", label: "Races", Icon: LuUsers },
  { id: "conditions", label: "Conditions", Icon: LuFlame },
  { id: "damage-types", label: "Damage Types", Icon: LuPuzzle },
  { id: "magic-schools", label: "Magic Schools", Icon: LuGraduationCap },
];

interface ListItem {
  index: string;
  name: string;
  url: string;
  [key: string]: unknown;
}

interface Meta {
  url: string;
  status: number;
  ms: number;
  count?: number;
}

// ── Image modal ──────────────────────────────────────────────────────────────

function ImageModal({ src, onClose }: { src: string; onClose: () => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={backdropRef}
      className="hc-img-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div className="hc-img-modal">
        <button
          type="button"
          className="hc-img-close"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <LuX size={16} />
        </button>
        <img src={src} alt="D&D resource" className="hc-img-preview" />
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="hc-img-link"
        >
          {src}
        </a>
      </div>
    </div>
  );
}

// ── JSON tree ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function JsonNode({
  label,
  value,
  depth,
  onImageClick,
}: {
  label?: string;
  value: unknown;
  depth: number;
  onImageClick?: (url: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isBranch = Array.isArray(value) || isRecord(value);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : isRecord(value)
      ? Object.entries(value)
      : [];

  const kind = Array.isArray(value) ? "array" : isRecord(value) ? "object" : typeof value;

  // Detect image paths: key is "image" and value starts with "/api/"
  const isImageValue =
    label === "image" &&
    typeof value === "string" &&
    value.startsWith("/api/");

  const renderPrimitive = () => {
    if (value === null) return <span className="hc-json-null">null</span>;
    if (isImageValue) {
      const fullUrl = `${IMAGE_BASE}${value as string}`;
      return (
        <span className="hc-json-string">
          "
          <button
            type="button"
            className="hc-json-img-link"
            onClick={() => onImageClick?.(fullUrl)}
            title="Click to preview image"
          >
            <LuImage size={11} aria-hidden="true" />
            {value as string}
          </button>
          "
        </span>
      );
    }
    if (typeof value === "string") return <span className="hc-json-string">"{value}"</span>;
    if (typeof value === "number") return <span className="hc-json-number">{value}</span>;
    if (typeof value === "boolean") return <span className="hc-json-bool">{String(value)}</span>;
    return <span>{String(value)}</span>;
  };

  return (
    <div className="hc-json-row" style={{ paddingLeft: depth * 14 }}>
      {isBranch ? (
        <>
          <button
            type="button"
            className="hc-json-toggle"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <span className="hc-json-caret">{open ? "▾" : "▸"}</span>
            {label !== undefined && <span className="hc-json-key">{label}</span>}
            <span className="hc-json-meta">
              {kind === "array" ? `[${entries.length}]` : `{${entries.length}}`}
            </span>
          </button>
          {open &&
            entries.map(([k, v]) => (
              <JsonNode
                key={k}
                label={k}
                value={v}
                depth={depth + 1}
                onImageClick={onImageClick}
              />
            ))}
        </>
      ) : (
        <span className="hc-json-leaf">
          {label !== undefined && <span className="hc-json-key">{label}: </span>}
          {renderPrimitive()}
        </span>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function HttpClient() {
  const [resource, setResource] = useState<Resource>(RESOURCES[0]);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<string | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const loadList = useCallback(
    async (res: Resource, q: string) => {
      setLoading(true);
      setError(null);
      setItems(null);
      setDetail(null);
      setSelectedIndex(null);
      setMeta(null);
      try {
        const url = q ? `${BASE}/${res.id}?name=${encodeURIComponent(q)}` : `${BASE}/${res.id}`;
        const { status, body, ms } = await httpGet(url);
        const data = JSON.parse(body) as { count: number; results: ListItem[] };
        setItems(data.results ?? []);
        setMeta({ url, status, ms: Math.round(ms), count: data.count });
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadDetail = useCallback(async (res: Resource, index: string) => {
    setLoading(true);
    setError(null);
    setSelectedIndex(index);
    setDetail(null);
    try {
      const url = `${BASE}/${res.id}/${index}`;
      const { status, body, ms } = await httpGet(url);
      setDetail(JSON.parse(body));
      setMeta({ url, status, ms: Math.round(ms) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList(resource, "");
  }, [resource, loadList]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void loadList(resource, query.trim());
  }

  /** Extra list fields beyond index/name/url, e.g. spell level or CR. */
  function secondaryLine(item: ListItem): string {
    return Object.entries(item)
      .filter(([k]) => k !== "index" && k !== "name" && k !== "url")
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
      .join("  ·  ");
  }

  const detailText = detail !== null ? JSON.stringify(detail, null, 2) : "";

  return (
    <div className="hc-page">
      <header className="hc-header">
        <h1 className="hc-title">HTTP Client</h1>
        <p className="hc-subtitle">D&amp;D 5e SRD API — public, no auth, GET only</p>
      </header>

      <div className="hc-body">
        <nav className="hc-sidebar" aria-label="Resources">
          <div className="hc-sidebar-heading">Resources</div>
          {RESOURCES.map((res) => (
            <button
              key={res.id}
              type="button"
              className={`hc-sidebar-item${res.id === resource.id ? " active" : ""}`}
              onClick={() => {
                setResource(res);
                setQuery("");
              }}
            >
              <span className="hc-sidebar-icon">
                <res.Icon size={15} aria-hidden="true" />
              </span>
              {res.label}
            </button>
          ))}
        </nav>

        <div className="hc-main">
          <div className="hc-toolbar">
            <form className="hc-search" onSubmit={submit}>
              <input
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder={`Search ${resource.label.toLowerCase()} by name…`}
                aria-label={`Search ${resource.label}`}
              />
              <button type="submit" className="hc-btn" disabled={loading}>
                {loading ? <LuLoaderCircle className="hc-spin" size={14} /> : <LuSearch size={14} />}
                Search
              </button>
            </form>
            <span className="hc-request-line">
              <LuGlobe size={12} aria-hidden="true" />
              GET {meta?.url ?? `${BASE}/${resource.id}`}
            </span>
          </div>

          {error && (
            <div className="hc-banner hc-banner--error">
              <LuX size={14} aria-hidden="true" />
              {error}
            </div>
          )}

          <div className="hc-split">
            <div className="hc-list">
              {loading && items === null && (
                <div className="hc-empty">
                  <LuLoaderCircle className="hc-spin" size={22} aria-hidden="true" />
                  Fetching…
                </div>
              )}
              {items !== null && items.length === 0 && (
                <div className="hc-empty">No results for “{query}”.</div>
              )}
              {items?.map((item) => (
                <button
                  key={item.index}
                  type="button"
                  className={`hc-item${item.index === selectedIndex ? " active" : ""}`}
                  onClick={() => void loadDetail(resource, item.index)}
                >
                  <span className="hc-item-name">{item.name}</span>
                  <span className="hc-item-meta">{secondaryLine(item)}</span>
                </button>
              ))}
            </div>

            <div className="hc-detail">
              {detail === null ? (
                <div className="hc-empty">Select an entry to see the full response.</div>
              ) : (
                <>
                  <div className="hc-detail-bar">
                    <span className="hc-detail-title">
                      {isRecord(detail) && typeof detail.name === "string" ? detail.name : selectedIndex}
                    </span>
                    <button
                      type="button"
                      className="hc-btn hc-btn--ghost"
                      onClick={() => void copyText(detailText)}
                      title="Copy JSON"
                    >
                      <LuCopy size={13} aria-hidden="true" />
                      Copy
                    </button>
                  </div>
                  <div className="hc-json">
                    <JsonNode value={detail} depth={0} onImageClick={setPreviewUrl} />
                  </div>
                </>
              )}
            </div>
          </div>

          <footer className="hc-statusbar">
            {meta ? (
              <>
                <span className={`hc-status hc-status--${meta.status < 400 ? "ok" : "err"}`}>
                  {meta.status}
                </span>
                <span>{meta.ms} ms</span>
                {meta.count !== undefined && <span>{meta.count} entries</span>}
              </>
            ) : (
              <span>Ready</span>
            )}
          </footer>
        </div>
      </div>

      {previewUrl && (
        <ImageModal src={previewUrl} onClose={() => setPreviewUrl(null)} />
      )}
    </div>
  );
}
