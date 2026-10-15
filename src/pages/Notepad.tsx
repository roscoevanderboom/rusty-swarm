import { useCallback, useEffect, useRef, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import { LuPanelLeft, LuPlus, LuTrash2 } from "react-icons/lu";
import "../css/notepad.css";

/* ─── Types ───────────────────────────────────────────────────────────── */

interface Note {
  id: number;
  title: string;
  body: string;
  created_at: number; // unix ms
  updated_at: number; // unix ms
}

/* ─── DB helpers ──────────────────────────────────────────────────────── */

const DB_NAME = "sqlite:notepad.db";

async function getDb(): Promise<Database> {
  const db = await Database.load(DB_NAME);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    NOT NULL DEFAULT '',
      body       TEXT    NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

/* ─── Utilities ───────────────────────────────────────────────────────── */

function deriveTitle(body: string): string {
  const firstLine = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return firstLine.trim().slice(0, 40) || "Untitled";
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ─── Component ───────────────────────────────────────────────────────── */

export function Notepad() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [savedVisible, setSavedVisible] = useState(false);

  const dbRef = useRef<Database | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep a ref to activeId so async callbacks never capture a stale value
  const activeIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Keep a ref to body so the pending-save flush on note switch uses current text
  const bodyRef = useRef("");
  useEffect(() => {
    bodyRef.current = body;
  }, [body]);

  /* ── Flash "saved" indicator ── */
  const flashSaved = useCallback(() => {
    setSavedVisible(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSavedVisible(false), 1500);
  }, []);

  /* ── Persist a note to the DB ── */
  const flushSave = useCallback(
    async (id: number, text: string) => {
      const db = dbRef.current;
      if (!db) return;
      const title = deriveTitle(text);
      const now = Date.now();
      await db.execute(
        "UPDATE notes SET body = ?, title = ?, updated_at = ? WHERE id = ?",
        [text, title, now, id]
      );
      setNotes((prev) =>
        prev
          .map((n) =>
            n.id === id ? { ...n, body: text, title, updated_at: now } : n
          )
          .sort((a, b) => b.updated_at - a.updated_at)
      );
      flashSaved();
    },
    [flashSaved]
  );

  /* ── Load all notes ── */
  const loadNotes = useCallback(
    async (db: Database) => {
      const rows = await db.select<Note[]>(
        "SELECT * FROM notes ORDER BY updated_at DESC"
      );
      setNotes(rows);
      // Only set the active note on initial load (when nothing is selected yet)
      if (rows.length > 0 && activeIdRef.current === null) {
        setActiveId(rows[0].id);
        setBody(rows[0].body);
      }
    },
    [] // stable — reads activeIdRef instead of activeId
  );

  /* ── Mount: init DB ── */
  useEffect(() => {
    getDb()
      .then(async (db) => {
        dbRef.current = db;
        await loadNotes(db);
      })
      .catch(console.error);

    // Cleanup timers on unmount
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [loadNotes]);

  /* ── New note ── */
  async function handleNewNote() {
    const db = dbRef.current;
    if (!db) return;
    try {
      const now = Date.now();
      const result = await db.execute(
        "INSERT INTO notes (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ["", "", now, now]
      );
      const newNote: Note = {
        id: result.lastInsertId as number,
        title: "",
        body: "",
        created_at: now,
        updated_at: now,
      };
      setNotes((prev) => [newNote, ...prev]);
      setActiveId(newNote.id);
      setBody("");
    } catch (err) {
      console.error(err);
    }
  }

  /* ── Select note (flush pending save first) ── */
  function handleSelect(note: Note) {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      // Flush the in-flight text for the note we're leaving
      const currentId = activeIdRef.current;
      if (currentId !== null && currentId !== note.id) {
        flushSave(currentId, bodyRef.current).catch(console.error);
      }
    }
    setActiveId(note.id);
    setBody(note.body);
  }

  /* ── Textarea change with debounced save ── */
  function handleBodyChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value;
    setBody(text);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const id = activeIdRef.current;
      if (id !== null) flushSave(id, text).catch(console.error);
    }, 600);
  }

  /* ── Delete note ── */
  async function handleDelete(e: React.MouseEvent, noteId: number) {
    e.stopPropagation();
    const db = dbRef.current;
    if (!db) return;
    try {
      await db.execute("DELETE FROM notes WHERE id = ?", [noteId]);
      const remaining = notes.filter((n) => n.id !== noteId);
      setNotes(remaining);
      if (activeIdRef.current === noteId) {
        if (remaining.length > 0) {
          setActiveId(remaining[0].id);
          setBody(remaining[0].body);
        } else {
          setActiveId(null);
          setBody("");
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  /* ─── Render ────────────────────────────────────────────────────────── */

  return (
    <div className="np-page">
      {/* Toolbar */}
      <div className="np-bar">
        <button
          className="np-ghost"
          onClick={() => setSidebarOpen((o) => !o)}
          title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          <LuPanelLeft size={13} aria-hidden />
        </button>
        <span className="np-bar-title">notepad</span>
        <span className="np-spacer" />
        <span
          className={`np-saved${savedVisible ? " np-saved--visible" : ""}`}
          aria-live="polite"
          aria-label={savedVisible ? "Note saved" : undefined}
        >
          saved
        </span>
        <button
          className="np-ghost"
          onClick={() => handleNewNote().catch(console.error)}
          title="New note"
          aria-label="New note"
        >
          <LuPlus size={13} aria-hidden /> new note
        </button>
      </div>

      {/* Body */}
      <div className="np-body">
        {/* Sidebar */}
        <div
          className={`np-sidebar${sidebarOpen ? "" : " np-sidebar--collapsed"}`}
          aria-label="Note list"
          aria-hidden={!sidebarOpen}
        >
          {notes.length === 0 && (
            <div className="np-sidebar-empty">no notes yet</div>
          )}
          {notes.map((note) => (
            <div
              key={note.id}
              className={`np-note-item${note.id === activeId ? " np-note-item--active" : ""}`}
              onClick={() => handleSelect(note)}
              role="button"
              tabIndex={sidebarOpen ? 0 : -1}
              aria-current={note.id === activeId ? "true" : undefined}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") handleSelect(note);
              }}
            >
              <div className="np-note-item-inner">
                <div className="np-note-title">{note.title || "Untitled"}</div>
                <div className="np-note-date">{formatDate(note.updated_at)}</div>
              </div>
              <button
                className="np-note-delete np-ghost"
                onClick={(e) => handleDelete(e, note.id).catch(console.error)}
                title="Delete note"
                aria-label={`Delete note: ${note.title || "Untitled"}`}
                tabIndex={sidebarOpen ? 0 : -1}
              >
                <LuTrash2 size={11} aria-hidden />
              </button>
            </div>
          ))}
        </div>

        {/* Editor */}
        <div className="np-editor">
          {activeId === null ? (
            <div className="np-editor-empty">
              <span>no note selected —</span>
              <button
                className="np-ghost"
                onClick={() => handleNewNote().catch(console.error)}
              >
                create one
              </button>
            </div>
          ) : (
            <textarea
              className="np-textarea"
              value={body}
              onChange={handleBodyChange}
              placeholder="start writing…"
              autoFocus
              spellCheck
              aria-label="Note body"
            />
          )}
        </div>
      </div>
    </div>
  );
}
