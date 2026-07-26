import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Interview } from '../../../shared/types'

interface InterviewsPaneProps {
  interviews: Interview[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Active session id — used to scope the list to the current session by default. */
  sessionId: string | null
}

const KIND_LABELS: Record<string, string> = {
  behavioral: 'Behavioral',
  coding: 'Coding',
  frontend_concepts: 'Frontend concepts',
  system_design: 'System design',
  devops: 'DevOps'
}

function friendlyKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

function friendlyLevel(level: string): string {
  return level.length === 0 ? level : level[0].toUpperCase() + level.slice(1)
}

/** Formats a completion timestamp: "14:32" for today, "Jul 10" otherwise. Mirrors
 *  StudyPanel's formatWhiteboardTime so interview dates read consistently with
 *  whiteboard/exercise history timestamps. */
function formatInterviewDate(iso: string | null): string {
  if (iso === null) return ''
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

function scoreVariant(score: number): 'good' | 'ok' | 'bad' {
  if (score >= 80) return 'good'
  if (score >= 60) return 'ok'
  return 'bad'
}

function ScoreBadge({ score }: { score: number | null }): JSX.Element {
  if (score === null) {
    return <span className="interview-score-badge interview-score-pending">—</span>
  }
  return (
    <span className={`interview-score-badge interview-score-${scoreVariant(score)}`}>
      {score}/100
    </span>
  )
}

function InterviewRow({
  interview,
  onSelect
}: {
  interview: Interview
  onSelect: (id: string) => void
}): JSX.Element {
  return (
    <button type="button" className="interview-row" onClick={() => onSelect(interview.id)}>
      <div className="interview-row-main">
        <span className="interview-row-kind">{friendlyKind(interview.kind)}</span>
        <span className="interview-row-meta">
          {friendlyLevel(interview.level)} · {formatInterviewDate(interview.completedAt)}
        </span>
      </div>
      <ScoreBadge score={interview.overallScore} />
    </button>
  )
}

function InterviewDetail({
  interview,
  onBack
}: {
  interview: Interview
  onBack: () => void
}): JSX.Element {
  return (
    <div className="interviews-detail">
      <button type="button" className="interview-back-btn" onClick={onBack}>
        ← All interviews
      </button>

      <div className="interview-detail-header">
        <div className="interview-detail-heading">
          <h2 className="interview-detail-title">{friendlyKind(interview.kind)}</h2>
          <span className="interview-detail-meta">
            {friendlyLevel(interview.level)} · {formatInterviewDate(interview.completedAt)}
          </span>
        </div>
        <ScoreBadge score={interview.overallScore} />
      </div>

      {interview.scores.length > 0 && (
        <table className="interview-score-table">
          <tbody>
            {interview.scores.map((s) => (
              <tr key={s.dimension}>
                <td className="interview-score-dimension">{s.dimension}</td>
                <td className="interview-score-bar-cell">
                  <div className="interview-score-bar-track">
                    <div
                      className="interview-score-bar-fill"
                      style={{ width: `${Math.max(0, Math.min(10, s.score)) * 10}%` }}
                    />
                  </div>
                  <span className="interview-score-bar-value">{s.score}/10</span>
                </td>
                <td className="interview-score-comment">{s.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="interview-report markdown-body">
        {interview.reportMd !== null && interview.reportMd !== '' ? (
          <ReactMarkdown>{interview.reportMd}</ReactMarkdown>
        ) : (
          <div className="study-empty">No report available.</div>
        )}
      </div>
    </div>
  )
}

export default function InterviewsPane({
  interviews,
  selectedId,
  onSelect,
  sessionId
}: InterviewsPaneProps): JSX.Element {
  // Default to the current session's interviews; "All sessions" is the
  // improvement-over-time view, one click away.
  const [scope, setScope] = useState<'session' | 'all'>('session')

  // Detail view is reachable from either scope (e.g. a just-completed interview
  // auto-opens) — resolve against the full list.
  const selected = selectedId !== null ? interviews.find((i) => i.id === selectedId) ?? null : null

  if (selected !== null) {
    return <InterviewDetail interview={selected} onBack={() => onSelect(null)} />
  }

  const visible =
    scope === 'session' && sessionId !== null
      ? interviews.filter((i) => i.sessionId === sessionId)
      : interviews

  return (
    <div className="interviews-pane">
      <div className="interviews-scope" role="tablist" aria-label="Interview scope">
        <button
          type="button"
          className={`interviews-scope-btn${scope === 'session' ? ' interviews-scope-active' : ''}`}
          onClick={() => setScope('session')}
        >
          This session
        </button>
        <button
          type="button"
          className={`interviews-scope-btn${scope === 'all' ? ' interviews-scope-active' : ''}`}
          onClick={() => setScope('all')}
        >
          All sessions ({interviews.length})
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="study-empty">
          {scope === 'session' && interviews.length > 0
            ? 'No interviews in this session yet — switch to "All sessions" for your full history.'
            : 'No interviews yet — ask your tutor for a mock interview.'}
        </div>
      ) : (
        <div className="interviews-list">
          {visible.map((interview) => (
            <InterviewRow key={interview.id} interview={interview} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}
