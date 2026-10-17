import { useCallback, useEffect, useRef, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import {
  LuLoaderCircle,
  LuLoader,
  LuPencil,
  LuPlus,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import "../css/kanban.css";
import { singleFlight } from "../lib/singleFlight";

// ── Types ─────────────────────────────────────────────────────────────────────

type Priority = "low" | "medium" | "high";

interface Column {
  id: number;
  name: string;
  color: string;
  position: number;
}

interface Card {
  id: number;
  column_id: number;
  title: string;
  description: string;
  priority: Priority;
  created_at: string;
  position: number;
}

interface CardDraft {
  title: string;
  description: string;
  priority: Priority;
  column_id: number;
}

type ModalMode =
  | { type: "closed" }
  | { type: "add"; columnId: number }
  | { type: "edit"; card: Card };

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_COLUMNS: Omit<Column, "id">[] = [
  { name: "Backlog", color: "#6b7280", position: 0 },
  { name: "In Progress", color: "#6366f1", position: 1 },
  { name: "Review", color: "#d97706", position: 2 },
  { name: "Done", color: "#16a34a", position: 3 },
];

const PRIORITY_LABELS: Record<Priority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const DB_PATH = "sqlite:kanban.db";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function emptyDraft(columnId: number): CardDraft {
  return {
    title: "",
    description: "",
    priority: "medium",
    column_id: columnId,
  };
}

function draftFromCard(card: Card): CardDraft {
  return {
    title: card.title,
    description: card.description,
    priority: card.priority,
    column_id: card.column_id,
  };
}

// React StrictMode replays effects during development. Share the first empty-DB
// seed operation so overlapping effect setups cannot insert the defaults twice.
const seedDatabaseIfEmpty = singleFlight(async (db: Database) => {
  const existing = await db.select<Column[]>("SELECT * FROM kb_columns");
  if (existing.length !== 0) return;

  for (const col of DEFAULT_COLUMNS) {
    await db.execute(
      "INSERT INTO kb_columns (name, color, position) VALUES (?, ?, ?)",
      [col.name, col.color, col.position],
    );
  }
  const cols = await db.select<Column[]>("SELECT * FROM kb_columns ORDER BY position");
  if (cols.length < 4) return;

  const seed: [number, string, string, Priority, number][] = [
    [cols[0].id, "Research SQLite in Tauri", "Explore tauri-plugin-sql and understand its API surface.", "high", 0],
    [cols[0].id, "Design the board UI", "Sketch the Kanban layout — columns, cards, modal.", "medium", 1],
    [cols[1].id, "Build Kanban component", "Implement the board page with full CRUD wired to SQLite.", "high", 0],
    [cols[2].id, "Review drag-and-drop UX", "Test card movement between columns.", "low", 0],
    [cols[3].id, "Plugin wired to app", "tauri-plugin-sql registered, permissions set.", "low", 0],
  ];
  for (const [columnId, title, description, priority, position] of seed) {
    await db.execute(
      "INSERT INTO kb_cards (column_id, title, description, priority, position) VALUES (?, ?, ?, ?, ?)",
      [columnId, title, description, priority, position],
    );
  }
});

// ── Component ─────────────────────────────────────────────────────────────────

export function Kanban() {
  const dbRef = useRef<Database | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [cards, setCards] = useState<Card[]>([]);

  const [modal, setModal] = useState<ModalMode>({ type: "closed" });
  const [draft, setDraft] = useState<CardDraft>(emptyDraft(0));
  const [saving, setSaving] = useState(false);

  // ── DB init ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const db = await Database.load(DB_PATH);
        dbRef.current = db;

        await db.execute(`
          CREATE TABLE IF NOT EXISTS kb_columns (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            name     TEXT    NOT NULL,
            color    TEXT    NOT NULL DEFAULT '#6b7280',
            position INTEGER NOT NULL DEFAULT 0
          )
        `);
        await db.execute(`
          CREATE TABLE IF NOT EXISTS kb_cards (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            column_id   INTEGER NOT NULL REFERENCES kb_columns(id) ON DELETE CASCADE,
            title       TEXT    NOT NULL,
            description TEXT    NOT NULL DEFAULT '',
            priority    TEXT    NOT NULL DEFAULT 'medium',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            position    INTEGER NOT NULL DEFAULT 0
          )
        `);

        await seedDatabaseIfEmpty(db);

        if (!cancelled) {
          setReady(true);
          await loadAll(db);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }

    init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadAll = useCallback(async (db: Database) => {
    const [cols, cds] = await Promise.all([
      db.select<Column[]>("SELECT * FROM kb_columns ORDER BY position"),
      db.select<Card[]>("SELECT * FROM kb_cards ORDER BY position, id"),
    ]);
    setColumns(cols);
    setCards(cds);
  }, []);

  // ── Modal helpers ──────────────────────────────────────────────────────────

  function openAdd(columnId: number) {
    setDraft(emptyDraft(columnId));
    setModal({ type: "add", columnId });
  }

  function openEdit(card: Card) {
    setDraft(draftFromCard(card));
    setModal({ type: "edit", card });
  }

  function closeModal() {
    setModal({ type: "closed" });
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async function saveCard() {
    if (!draft.title.trim() || !dbRef.current) return;
    const db = dbRef.current;
    setSaving(true);
    try {
      if (modal.type === "add") {
        const [{ cnt }] = await db.select<[{ cnt: number }]>(
          "SELECT COUNT(*) as cnt FROM kb_cards WHERE column_id = ?",
          [draft.column_id],
        );
        await db.execute(
          "INSERT INTO kb_cards (column_id, title, description, priority, position) VALUES (?, ?, ?, ?, ?)",
          [
            draft.column_id,
            draft.title.trim(),
            draft.description.trim(),
            draft.priority,
            cnt,
          ],
        );
      } else if (modal.type === "edit") {
        await db.execute(
          "UPDATE kb_cards SET title = ?, description = ?, priority = ?, column_id = ? WHERE id = ?",
          [
            draft.title.trim(),
            draft.description.trim(),
            draft.priority,
            draft.column_id,
            modal.card.id,
          ],
        );
      }
      closeModal();
      await loadAll(db);
    } finally {
      setSaving(false);
    }
  }

  async function deleteCard(cardId: number) {
    if (!dbRef.current) return;
    await dbRef.current.execute("DELETE FROM kb_cards WHERE id = ?", [cardId]);
    closeModal();
    await loadAll(dbRef.current);
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const cardsForColumn = (colId: number) =>
    cards.filter((c) => c.column_id === colId);

  const modalTitle = modal.type === "add"
    ? `New card — ${columns.find((c) => c.id === modal.columnId)?.name ?? ""}`
    : modal.type === "edit"
    ? "Edit card"
    : "";

  const isOpen = modal.type !== "closed";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="kb-page">
      {/* Header */}
      <div className="kb-header">
        <span className="kb-title">Task Board</span>
        {error && (
          <span
            style={{
              fontSize: "0.75rem",
              color: "#e5484d",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <LuLoaderCircle size={14} /> {error}
          </span>
        )}
      </div>

      {/* Loading */}
      {!ready && !error && (
        <div className="kb-banner kb-banner--info">
          <LuLoader
            size={14}
            style={{ animation: "fe-spin 0.7s linear infinite" }}
          />
          Opening database…
        </div>
      )}

      {/* Board */}
      {ready && (
        <div className="kb-board">
          {columns.map((col) => {
            const colCards = cardsForColumn(col.id);
            return (
              <div key={col.id} className="kb-column">
                <div className="kb-column-header">
                  <div className="kb-column-title-row">
                    <span
                      className="kb-column-dot"
                      style={{ background: col.color }}
                    />
                    <span className="kb-column-name">{col.name}</span>
                  </div>
                  <span className="kb-column-count">{colCards.length}</span>
                </div>

                <div className="kb-cards">
                  {colCards.length === 0
                    ? <div className="kb-empty-col">No cards yet</div>
                    : (
                      colCards.map((card) => (
                        <div
                          key={card.id}
                          className="kb-card"
                          onClick={() => openEdit(card)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              openEdit(card);
                            }
                          }}
                          aria-label={`Edit card: ${card.title}`}
                        >
                          {/* Delete button */}
                          <button
                            className="kb-card-delete"
                            title="Delete card"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteCard(card.id);
                            }}
                            aria-label="Delete card"
                          >
                            <LuX size={13} aria-hidden />
                          </button>

                          <span className="kb-card-title">{card.title}</span>

                          {card.description && (
                            <span className="kb-card-desc">
                              {card.description}
                            </span>
                          )}

                          <div className="kb-card-footer">
                            <span
                              className={`kb-card-priority kb-card-priority--${card.priority}`}
                            >
                              {PRIORITY_LABELS[card.priority]}
                            </span>
                            <span className="kb-card-date">
                              {formatDate(card.created_at)}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                </div>

                <button
                  className="kb-add-card"
                  onClick={() => openAdd(col.id)}
                >
                  <LuPlus size={14} aria-hidden />
                  Add card
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit modal */}
      {isOpen && (
        <div
          className="kb-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={modal.type === "add" ? "Add card" : "Edit card"}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="kb-modal">
            <div className="kb-modal-header">
              <h2 className="kb-modal-title">{modalTitle}</h2>
              <button
                className="kb-modal-close"
                onClick={closeModal}
                aria-label="Close"
              >
                <LuX size={16} aria-hidden />
              </button>
            </div>

            {/* Title */}
            <div className="kb-modal-field">
              <label className="kb-modal-label" htmlFor="kb-card-title">
                Title
              </label>
              <input
                id="kb-card-title"
                className="kb-modal-input"
                type="text"
                placeholder="Card title…"
                value={draft.title}
                autoFocus
                onChange={(e) =>
                  setDraft((d) => ({ ...d, title: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveCard();
                  if (e.key === "Escape") closeModal();
                }}
              />
            </div>

            {/* Description */}
            <div className="kb-modal-field">
              <label className="kb-modal-label" htmlFor="kb-card-desc">
                Description
              </label>
              <textarea
                id="kb-card-desc"
                className="kb-modal-textarea"
                placeholder="Optional description…"
                value={draft.description}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>

            {/* Priority */}
            <div className="kb-modal-field">
              <label className="kb-modal-label" htmlFor="kb-card-priority">
                Priority
              </label>
              <select
                id="kb-card-priority"
                className="kb-modal-select"
                value={draft.priority}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    priority: e.target.value as Priority,
                  }))}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>

            {/* Column (edit only) */}
            {modal.type === "edit" && (
              <div className="kb-modal-field">
                <label className="kb-modal-label" htmlFor="kb-card-column">
                  Column
                </label>
                <select
                  id="kb-card-column"
                  className="kb-modal-select"
                  value={draft.column_id}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      column_id: Number(e.target.value),
                    }))}
                >
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="kb-modal-footer">
              {/* Delete button on edit modal */}
              {modal.type === "edit" && (
                <button
                  className="kb-btn kb-btn--danger"
                  onClick={() => deleteCard(modal.card.id)}
                  style={{ marginRight: "auto" }}
                >
                  <LuTrash2 size={14} aria-hidden />
                  Delete
                </button>
              )}
              <button className="kb-btn kb-btn--ghost" onClick={closeModal}>
                Cancel
              </button>
              <button
                className="kb-btn"
                onClick={saveCard}
                disabled={!draft.title.trim() || saving}
              >
                <LuPencil size={14} aria-hidden />
                {modal.type === "add" ? "Add card" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Kanban;
