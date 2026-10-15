import { useEffect, useRef, useState } from "react";
import WebSocket from "@tauri-apps/plugin-websocket";

import "../css/system-monitor.css";
import { useSettings } from "../hooks";
import { vaultGetApiKey } from "../lib/secrets";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface CpuData   { total: number; cores: number[] }
interface MemData   { used: number; total: number; swap_used: number; swap_total: number }
interface DiskData  { mount: string; used: number; total: number }
interface NetData   { rx_bytes: number; tx_bytes: number }

interface Metrics {
  uptime: number;
  cpu: CpuData;
  memory: MemData;
  disks: DiskData[];
  network: NetData;
}

type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "error";

/* ─── Formatters ─────────────────────────────────────────────────────── */

function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(0)} MB`;
  if (n >= 1_024)         return `${(n / 1_024).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtBytesPerSec(n: number, intervalMs: number): string {
  const perSec = (n * 1000) / intervalMs;
  if (perSec >= 1_048_576) return `${(perSec / 1_048_576).toFixed(1)} MB/s`;
  if (perSec >= 1_024)     return `${(perSec / 1_024).toFixed(0)} KB/s`;
  return `${perSec.toFixed(0)} B/s`;
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `up ${d}d ${h}h`;
  if (h > 0) return `up ${h}h ${m}m`;
  return `up ${m}m`;
}

function pct(used: number, total: number): number {
  return total > 0 ? Math.min(100, (used / total) * 100) : 0;
}

/* ─── SVG Gauge ──────────────────────────────────────────────────────── */

const R = 30;
const CIRC = 2 * Math.PI * R;
// Arc from 135° to 405° (270° sweep) so it looks like a horseshoe
const ARC_DEG = 270;
const ARC_FRAC = ARC_DEG / 360;
const ARC_LEN = CIRC * ARC_FRAC;
const GAP_LEN = CIRC * (1 - ARC_FRAC);

function Gauge({ value }: { value: number }) {
  const filled = ARC_LEN * (value / 100);
  // Rotation: start at 135deg (bottom-left), stroke going clockwise
  return (
    <svg className="sm-gauge-wrap" viewBox="0 0 80 80" aria-label={`${value.toFixed(0)}%`}>
      {/* Background arc */}
      <circle
        className="sm-gauge-bg"
        cx="40" cy="40" r={R}
        fill="none"
        strokeWidth="7"
        strokeDasharray={`${ARC_LEN} ${GAP_LEN}`}
        strokeLinecap="round"
        transform="rotate(135 40 40)"
      />
      {/* Value arc */}
      <circle
        className="sm-gauge-arc"
        cx="40" cy="40" r={R}
        fill="none"
        strokeWidth="7"
        strokeDasharray={`${filled} ${CIRC - filled}`}
        strokeDashoffset={0}
        strokeLinecap="round"
        transform="rotate(135 40 40)"
      />
      <text className="sm-gauge-text" x="40" y="38">{value.toFixed(0)}%</text>
      <text className="sm-gauge-sub"  x="40" y="50">cpu</text>
    </svg>
  );
}

/* ─── Sparkline ──────────────────────────────────────────────────────── */

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return <svg className="sm-sparkline-wrap" />;
  const W = 200;
  const H = 48;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - (v / max) * H;
    return `${x},${y}`;
  });
  const polyline = pts.join(" ");
  const area = `${pts[0]} ${pts.join(" ")} ${(data.length - 1) / (data.length - 1) * W},${H} 0,${H}`;

  return (
    <svg
      className="sm-sparkline-wrap"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon className="sm-sparkline-area" points={area} />
      <polyline className="sm-sparkline-line" points={polyline} />
    </svg>
  );
}

/* ─── Bar row ────────────────────────────────────────────────────────── */

function BarRow({
  label,
  value,
  pctVal,
  wideLabel,
}: {
  label: string;
  value: string;
  pctVal: number;
  wideLabel?: boolean;
}) {
  const fill = pctVal > 90 ? "sm-bar-fill--err" : pctVal > 70 ? "sm-bar-fill--warn" : "";
  return (
    <div className="sm-row">
      <span className={`sm-row-label${wideLabel ? " sm-row-label--wide" : ""}`}>{label}</span>
      <div className="sm-bar-track">
        <div className={`sm-bar-fill ${fill}`} style={{ width: `${pctVal}%` }} />
      </div>
      <span className="sm-row-value">{value}</span>
    </div>
  );
}

/* ─── Panels ─────────────────────────────────────────────────────────── */

function CpuPanel({ cpu, spark }: { cpu: CpuData; spark: number[] }) {
  return (
    <div className="sm-panel">
      <div className="sm-panel-title">cpu</div>
      <div className="sm-cpu-top">
        <Gauge value={cpu.total} />
        <Sparkline data={spark} />
      </div>
      <div className="sm-rows">
        {cpu.cores.map((c, i) => (
          <BarRow key={i} label={`core${i}`} value={`${c.toFixed(0)}%`} pctVal={c} />
        ))}
      </div>
    </div>
  );
}

function MemPanel({ mem }: { mem: MemData }) {
  const ramPct = pct(mem.used, mem.total);
  const swapPct = pct(mem.swap_used, mem.swap_total);
  return (
    <div className="sm-panel">
      <div className="sm-panel-title">memory / swap</div>
      <div className="sm-section-label">ram</div>
      <div className="sm-rows">
        <BarRow
          label="used"
          value={fmtBytes(mem.used)}
          pctVal={ramPct}
        />
        <BarRow
          label="total"
          value={fmtBytes(mem.total)}
          pctVal={100}
        />
      </div>
      {mem.swap_total > 0 && (
        <>
          <div className="sm-section-label">swap</div>
          <div className="sm-rows">
            <BarRow
              label="used"
              value={fmtBytes(mem.swap_used)}
              pctVal={swapPct}
            />
            <BarRow
              label="total"
              value={fmtBytes(mem.swap_total)}
              pctVal={100}
            />
          </div>
        </>
      )}
    </div>
  );
}

function NetPanel({ net, intervalMs }: { net: NetData; intervalMs: number }) {
  return (
    <div className="sm-panel">
      <div className="sm-panel-title">network</div>
      <div className="sm-net-row">
        <span className="sm-net-arrow">↓</span>
        <span className="sm-net-label">rx</span>
        <span className="sm-net-value">{fmtBytesPerSec(net.rx_bytes, intervalMs)}</span>
      </div>
      <div className="sm-net-row">
        <span className="sm-net-arrow">↑</span>
        <span className="sm-net-label">tx</span>
        <span className="sm-net-value">{fmtBytesPerSec(net.tx_bytes, intervalMs)}</span>
      </div>
    </div>
  );
}

function DiskPanel({ disks }: { disks: DiskData[] }) {
  return (
    <div className="sm-panel">
      <div className="sm-panel-title">disks</div>
      <div className="sm-rows">
        {disks.map((d) => {
          const p = pct(d.used, d.total);
          return (
            <BarRow
              key={d.mount}
              label={d.mount}
              value={`${p.toFixed(0)}%`}
              pctVal={p}
              wideLabel
            />
          );
        })}
      </div>
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────── */

const SPARKLINE_MAX = 60;
const INTERVAL_MS = 1000;

export function SystemMonitor() {
  const { settings } = useSettings();
  const [connState, setConnState] = useState<ConnState>("idle");
  const [statusText, setStatusText] = useState("not connected");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [spark, setSpark] = useState<number[]>([]);

  const wsRef  = useRef<Awaited<ReturnType<typeof WebSocket.connect>> | null>(null);
  const retry  = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.disconnect().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!settings.apiEnabled) {
      setConnState("idle");
      setStatusText("enable the REST API in settings to use system monitor");
      return;
    }

    let cancelled = false;

    async function connect() {
      if (cancelled) return;

      const host = settings.apiHost === "0.0.0.0" ? "127.0.0.1" : settings.apiHost;
      const apiKey = await vaultGetApiKey();
      const url = `ws://${host}:${settings.apiPort}/v1/ws/metrics${apiKey ? `?token=${apiKey}` : ""}`;

      setConnState("connecting");
      setStatusText(`connecting to ${url.replace(/\?.*/, "")}…`);

      try {
        const ws = await WebSocket.connect(url);
        if (cancelled) { ws.disconnect().catch(() => {}); return; }

        wsRef.current = ws;
        retry.current = 0;
        setConnState("connected");
        setStatusText(`ws://${host}:${settings.apiPort}/v1/ws/metrics`);

        // Ask for our preferred interval
        await ws.send(`{"interval":${INTERVAL_MS}}`);

        ws.addListener((msg) => {
          if (msg.type !== "Text") return;
          try {
            const m = JSON.parse(msg.data as string) as Metrics;
            if (!mounted.current) return;
            setMetrics(m);
            setSpark((prev) => {
              const next = [...prev, m.cpu.total];
              return next.length > SPARKLINE_MAX ? next.slice(-SPARKLINE_MAX) : next;
            });
          } catch { /* ignore malformed frames */ }
        });

      } catch (err) {
        if (cancelled) return;
        const msg = String(err);
        // 403 = readMetrics permission is off — stop retrying, show actionable hint
        if (msg.includes("403")) {
          setConnState("error");
          setStatusText('403 Forbidden — enable "Read system metrics" in Settings → Server → Allowed actions');
          return;
        }
        const delay = Math.min(16000, 1000 * Math.pow(2, retry.current));
        retry.current++;
        setConnState("reconnecting");
        setStatusText(`reconnecting in ${delay / 1000}s… (${msg})`);
        timerRef.current = setTimeout(() => { if (!cancelled) connect(); }, delay);
      }
    }

    connect();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.disconnect().catch(() => {});
      wsRef.current = null;
    };
  // Re-connect when server settings change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiEnabled, settings.apiHost, settings.apiPort, settings.apiPermissions.readMetrics]);

  const host = settings.apiHost === "0.0.0.0" ? "127.0.0.1" : settings.apiHost;
  const barUrl = `ws://${host}:${settings.apiPort}/v1/ws/metrics`;

  return (
    <main className="sm-page">
      {/* Top bar */}
      <header className="sm-bar">
        <span className="sm-bar-title">
          <span className="sm-dot" data-state={connState} aria-hidden="true" />
          System Monitor
        </span>
        <span className="sm-chip">{connState}</span>
        <span className="sm-spacer" />
        {metrics && (
          <span className="sm-uptime">{fmtUptime(metrics.uptime)}</span>
        )}
        <span className="sm-chip">{barUrl}</span>
      </header>

      {/* Body */}
      <div className="sm-body">
        {!metrics ? (
          <div className="sm-overlay">
            <div className="sm-overlay-title">
              {connState === "error" ? "connection refused" : statusText}
            </div>
            <div className="sm-overlay-hint">
              {!settings.apiEnabled
                ? "Open Settings → Server, enable the REST API, then turn on \"Read system metrics\" under Allowed actions."
                : connState === "error" && statusText.includes("403")
                ? "Turn on \"Read system metrics\" under Settings → Server → Allowed actions, then revisit this page."
                : connState === "error"
                ? statusText
                : connState === "reconnecting"
                ? statusText
                : null
              }
            </div>
          </div>
        ) : (
          <div className="sm-grid">
            <CpuPanel cpu={metrics.cpu} spark={spark} />
            <MemPanel mem={metrics.memory} />
            <NetPanel net={metrics.network} intervalMs={INTERVAL_MS} />
            <DiskPanel disks={metrics.disks} />
          </div>
        )}
      </div>
    </main>
  );
}
