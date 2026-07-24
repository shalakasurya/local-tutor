import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Note, Session } from '../../../shared/types'

interface NotesViewProps {
  sessions: Session[]
  onBack: () => void
  /** Registers (on mount) / unregisters (on unmount, via null) a listNotes-only refresh
   *  callback that App invokes when a 'notes-updated' event arrives while this view is open. */
  registerRefresh: (fn: (() => void) | null) => void
}

/** Notes whose session is null, or whose session was deleted, are grouped into a single
 *  synthetic notebook with this key (never a real session id — session ids are UUIDs). */
const UNFILED_KEY = '__unfiled__'

interface Notebook {
  /** sessionId for real notebooks, UNFILED_KEY for the unfiled bucket. */
  key: string
  sessionId: string | null
  title: string
  notes: Note[]
}

/** Formats a note timestamp: "14:32" for today, "Jul 10" otherwise. Mirrors
 *  StudyPanel's formatWhiteboardTime so dates read consistently across the app. */
function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Slugifies a topic name into a stable DOM id for the #anchor topic index. */
function topicAnchorId(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `note-topic-${slug || 'untitled'}`
}

/** Groups a flat, already-ordered note list into [topic, notes] pairs, preserving
 *  input order (listNotes returns rows ordered by topic then created_at ascending, so
 *  this keeps topics alphabetical and each topic's entries chronological). */
function groupByTopic(list: Note[]): Array<[string, Note[]]> {
  const map = new Map<string, Note[]>()
  for (const note of list) {
    const entries = map.get(note.topic)
    if (entries) {
      entries.push(note)
    } else {
      map.set(note.topic, [note])
    }
  }
  return Array.from(map.entries())
}

/** The most recently created note in a list (list is assumed non-empty). */
function latestNote(list: Note[]): Note {
  let best = list[0]
  let bestTime = new Date(best.createdAt).getTime()
  for (const note of list) {
    const t = new Date(note.createdAt).getTime()
    if (!Number.isNaN(t) && (Number.isNaN(bestTime) || t > bestTime)) {
      best = note
      bestTime = t
    }
  }
  return best
}

interface NoteEntryProps {
  note: Note
  onSave: (id: string, contentMd: string) => void
  onDelete: (id: string) => void
}

function NoteEntry({ note, onSave, onDelete }: NoteEntryProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.contentMd)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  // Size the textarea to its content as soon as it mounts (entering edit mode).
  useEffect(() => {
    if (editing) {
      const id = requestAnimationFrame(autoGrow)
      return () => cancelAnimationFrame(id)
    }
    return undefined
  }, [editing, autoGrow])

  const startEdit = (): void => {
    setDraft(note.contentMd)
    setEditing(true)
  }

  const cancelEdit = (): void => {
    setDraft(note.contentMd)
    setEditing(false)
  }

  const saveEdit = (): void => {
    const trimmed = draft.trim()
    setEditing(false)
    if (trimmed === '' || trimmed === note.contentMd) return
    onSave(note.id, trimmed)
  }

  const handleDelete = (): void => {
    if (window.confirm('Delete this note?')) {
      onDelete(note.id)
    }
  }

  return (
    <div className="note-card">
      {editing ? (
        <div className="note-edit">
          <textarea
            ref={textareaRef}
            className="note-edit-textarea"
            value={draft}
            autoFocus
            onChange={(e) => {
              setDraft(e.target.value)
              autoGrow()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                cancelEdit()
              }
            }}
          />
          <div className="note-edit-actions">
            <button type="button" className="note-edit-cancel" onClick={cancelEdit}>
              Cancel
            </button>
            <button type="button" className="note-edit-save" onClick={saveEdit}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="note-card-body markdown-body">
            <ReactMarkdown>{note.contentMd}</ReactMarkdown>
          </div>
          <div className="note-card-footer">
            <span className="note-card-source">{formatDate(note.createdAt)}</span>
            {note.edited && <span className="note-edited-marker">edited</span>}
          </div>
          <div className="note-card-actions">
            <button
              type="button"
              className="note-action-btn"
              aria-label="Edit note"
              onClick={startEdit}
            >
              ✎
            </button>
            <button
              type="button"
              className="note-action-btn note-action-delete"
              aria-label="Delete note"
              onClick={handleDelete}
            >
              🗑
            </button>
          </div>
        </>
      )}
    </div>
  )
}

interface NotebookDetailProps {
  notebook: Notebook
  onBack: () => void
  onSave: (id: string, contentMd: string) => void
  onDelete: (id: string) => void
  errorBanner: JSX.Element | null
}

function NotebookDetail({
  notebook,
  onBack,
  onSave,
  onDelete,
  errorBanner
}: NotebookDetailProps): JSX.Element {
  const topics = useMemo(() => groupByTopic(notebook.notes), [notebook.notes])

  return (
    <>
      <div className="notes-header">
        <button type="button" className="notes-back-btn" onClick={onBack}>
          ← All notebooks
        </button>
        <h1 className="notes-title">{notebook.title}</h1>
        <span className="notes-count">
          {notebook.notes.length} note{notebook.notes.length === 1 ? '' : 's'} across{' '}
          {topics.length} topic{topics.length === 1 ? '' : 's'}
        </span>
        <button type="button" className="notes-print-btn" onClick={() => window.print()}>
          Print
        </button>
      </div>

      {errorBanner}

      <div className="notes-body">
        {topics.length > 3 && (
          <nav className="notes-topic-index" aria-label="Topics">
            {topics.map(([topic]) => (
              <a
                key={topic}
                href={`#${topicAnchorId(topic)}`}
                className="topic-chip notes-topic-chip"
              >
                {topic}
              </a>
            ))}
          </nav>
        )}
        {topics.map(([topic, entries]) => (
          <section key={topic} id={topicAnchorId(topic)} className="notes-topic-section">
            <h2 className="notes-topic-heading">{topic}</h2>
            <div className="notes-entries">
              {entries.map((note) => (
                <NoteEntry key={note.id} note={note} onSave={onSave} onDelete={onDelete} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}

export default function NotesView({
  sessions,
  onBack,
  registerRefresh
}: NotesViewProps): JSX.Element {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [catchingUp, setCatchingUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The notebook the user explicitly opened from the list; null means "show the list"
  // (unless auto-open kicks in — see activeNotebook below).
  const [openKey, setOpenKey] = useState<string | null>(null)

  // Single reload path for both the initial mount (which runs catch-up distillation
  // first) and event-driven refreshes (which must only re-list — see the header note
  // on 'notes-updated' in App.tsx for why backfill must not re-run there).
  const reload = useCallback(async (withBackfill: boolean) => {
    setError(null)
    if (withBackfill) {
      setLoading(true)
      setCatchingUp(true)
    }
    try {
      if (withBackfill) {
        await window.tutor.backfillNotes()
        setCatchingUp(false)
      }
      const list = await window.tutor.listNotes()
      setNotes(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notes')
      setCatchingUp(false)
    } finally {
      if (withBackfill) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload(true)
    registerRefresh(() => void reload(false))
    return () => registerRefresh(null)
  }, [reload, registerRefresh])

  const notebookTitleFor = useCallback(
    (sessionId: string): string => {
      const session = sessions.find((s) => s.id === sessionId)
      return session && session.title ? session.title : 'Earlier session'
    },
    [sessions]
  )

  // Groups notes into per-session notebooks (sessions must never mix), ordered by most
  // recent note. Notes with no session, or whose session was deleted, fall into a single
  // "Unfiled" notebook shown last regardless of recency.
  const notebooks = useMemo<Notebook[]>(() => {
    const bySession = new Map<string, Note[]>()
    const unfiled: Note[] = []
    for (const note of notes) {
      const knownSession =
        note.sessionId !== null && sessions.some((s) => s.id === note.sessionId)
      if (knownSession) {
        const sessionId = note.sessionId as string
        const list = bySession.get(sessionId)
        if (list) {
          list.push(note)
        } else {
          bySession.set(sessionId, [note])
        }
      } else {
        unfiled.push(note)
      }
    }

    const result: Notebook[] = Array.from(bySession.entries()).map(([sessionId, list]) => ({
      key: sessionId,
      sessionId,
      title: notebookTitleFor(sessionId),
      notes: list
    }))
    result.sort(
      (a, b) =>
        new Date(latestNote(b.notes).createdAt).getTime() -
        new Date(latestNote(a.notes).createdAt).getTime()
    )

    if (unfiled.length > 0) {
      result.push({ key: UNFILED_KEY, sessionId: null, title: 'Unfiled', notes: unfiled })
    }
    return result
  }, [notes, sessions, notebookTitleFor])

  // Resolves which notebook (if any) is currently open: either the one the user picked
  // from the list, or — when there's exactly one notebook — it's opened automatically
  // (the list would be pointless with a single entry).
  const activeNotebook = useMemo<Notebook | null>(() => {
    if (openKey !== null) {
      const found = notebooks.find((nb) => nb.key === openKey)
      if (found) return found
    }
    return notebooks.length === 1 ? notebooks[0] : null
  }, [notebooks, openKey])

  const isAutoOpened = activeNotebook !== null && openKey === null

  const handleSave = useCallback((id: string, contentMd: string) => {
    setNotes((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, contentMd, edited: true, updatedAt: new Date().toISOString() } : n
      )
    )
    window.tutor.updateNote(id, contentMd).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to save note')
    })
  }, [])

  const handleDelete = useCallback((id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id))
    window.tutor.deleteNote(id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to delete note')
    })
  }, [])

  const handleBackFromDetail = useCallback(() => {
    // With only one notebook the list is skipped entirely, so "back" from it should
    // leave the notes view altogether rather than bounce to a pointless single-card list.
    if (isAutoOpened) {
      onBack()
    } else {
      setOpenKey(null)
    }
  }, [isAutoOpened, onBack])

  const errorBanner =
    error !== null ? (
      <div className="error-banner" role="alert">
        <span className="error-banner-text">{error}</span>
        <button
          type="button"
          className="error-banner-dismiss"
          onClick={() => setError(null)}
          aria-label="Dismiss error"
        >
          ×
        </button>
      </div>
    ) : null

  if (activeNotebook !== null) {
    return (
      <main className="classroom notes-view">
        <NotebookDetail
          notebook={activeNotebook}
          onBack={handleBackFromDetail}
          onSave={handleSave}
          onDelete={handleDelete}
          errorBanner={errorBanner}
        />
      </main>
    )
  }

  return (
    <main className="classroom notes-view">
      <div className="notes-header">
        <button type="button" className="notes-back-btn" onClick={onBack}>
          ← Back
        </button>
        <h1 className="notes-title">📓 Study Notes</h1>
        <span className="notes-count">
          {notes.length} note{notes.length === 1 ? '' : 's'} across {notebooks.length} notebook
          {notebooks.length === 1 ? '' : 's'}
        </span>
      </div>

      {errorBanner}

      <div className="notes-body">
        {loading ? (
          <div className="study-empty">
            {catchingUp ? 'Catching up on your notes…' : 'Loading…'}
          </div>
        ) : notebooks.length === 0 ? (
          <div className="study-empty">
            No notes yet — they'll appear as you learn with your tutor.
          </div>
        ) : (
          <div className="notebook-list">
            {notebooks.map((notebook) => {
              const topicCount = groupByTopic(notebook.notes).length
              return (
                <button
                  key={notebook.key}
                  type="button"
                  className="notebook-row"
                  onClick={() => setOpenKey(notebook.key)}
                >
                  <span className="notebook-row-main">
                    <span className="notebook-row-title">{notebook.title}</span>
                    <span className="notebook-row-meta">
                      {notebook.notes.length} note{notebook.notes.length === 1 ? '' : 's'} ·{' '}
                      {topicCount} topic{topicCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="notebook-row-date">
                    {formatDate(latestNote(notebook.notes).createdAt)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </main>
  )
}
