import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { Session } from '../../../shared/types'

interface SessionSidebarProps {
  sessions: Session[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNewSession: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  notesActive: boolean
  onOpenNotes: () => void
}

function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function SessionSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onNewSession,
  onDelete,
  onRename,
  notesActive,
  onOpenNotes
}: SessionSidebarProps): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Focus + select the input's text whenever a rename begins.
  useEffect(() => {
    if (editingId !== null && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  const startRename = (session: Session): void => {
    setEditingId(session.id)
    setDraftTitle(session.title)
  }

  const commitRename = (session: Session): void => {
    const trimmed = draftTitle.trim()
    if (trimmed !== '' && trimmed !== session.title) {
      onRename(session.id, trimmed)
    }
    setEditingId(null)
  }

  const cancelRename = (): void => {
    setEditingId(null)
  }

  const handleDelete = (session: Session): void => {
    const confirmed = window.confirm(
      `Delete "${session.title}" and its transcript? This can't be undone.`
    )
    if (confirmed) {
      onDelete(session.id)
    }
  }

  return (
    <aside className="sidebar">
      <div className="wordmark">Local Tutor</div>

      <button type="button" className="new-session-btn" onClick={onNewSession}>
        + New session
      </button>

      <button
        type="button"
        className={notesActive ? 'notes-nav-btn notes-nav-btn-active' : 'notes-nav-btn'}
        aria-pressed={notesActive}
        onClick={onOpenNotes}
      >
        📓 Notes
      </button>

      <nav className="session-list" aria-label="Sessions">
        {sessions.length === 0 ? (
          <div className="session-list-empty">No sessions yet</div>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === activeSessionId
            const isEditing = editingId === session.id

            const handleItemClick = (): void => {
              if (isEditing) return
              onSelect(session.id)
            }

            const handleItemKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
              if (isEditing) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(session.id)
              }
            }

            const stop = (event: MouseEvent): void => event.stopPropagation()

            return (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                className={
                  isActive ? 'session-item session-item-active' : 'session-item'
                }
                onClick={handleItemClick}
                onKeyDown={handleItemKeyDown}
              >
                <div className="session-item-main">
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      type="text"
                      className="session-title-input"
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onClick={stop}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitRename(session)
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelRename()
                        }
                      }}
                      onBlur={() => commitRename(session)}
                    />
                  ) : (
                    <span className="session-title">{session.title}</span>
                  )}
                  <span className="session-date">{formatRelativeDate(session.updatedAt)}</span>
                </div>

                {!isEditing && (
                  <div className="session-item-actions">
                    <button
                      type="button"
                      className="session-action-btn session-action-rename"
                      aria-label={`Rename ${session.title}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        startRename(session)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="session-action-btn session-action-delete"
                      aria-label={`Delete ${session.title}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(session)
                      }}
                    >
                      🗑
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </nav>
    </aside>
  )
}
