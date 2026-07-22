import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Lesson, ProgressNote } from '../../../shared/types'
import { dueForReview, summarizeTopics } from '../lib/review'
import type { TopicStatus } from '../lib/review'

interface LibraryPaneProps {
  onStudentMessage: (text: string) => void
}

type Section = 'review' | 'lessons' | 'progress'

const MASTERY_LABELS: Record<ProgressNote['mastery'], string> = {
  struggling: 'Struggling',
  learning: 'Learning',
  solid: 'Solid'
}

const STATUS_LABELS: Record<Lesson['status'], string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  completed: 'Completed'
}

const MAX_REVIEW_TOPICS = 8

function MasteryBadge({ mastery }: { mastery: ProgressNote['mastery'] }): JSX.Element {
  return (
    <span className={`mastery-badge mastery-badge-${mastery}`}>{MASTERY_LABELS[mastery]}</span>
  )
}

/** Formats a timestamp: "14:32" for today, "Jul 10" otherwise. Mirrors StudyPanel's
 *  formatWhiteboardTime so dates read consistently across the study panel. */
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

function daysAgo(iso: string, now: Date): number {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 0
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)))
}

function daysAgoLabel(iso: string, now: Date): string {
  const n = daysAgo(iso, now)
  if (n === 0) return 'last touched today'
  if (n === 1) return 'last touched 1 day ago'
  return `last touched ${n} days ago`
}

function SegmentedControl({
  section,
  onChange
}: {
  section: Section
  onChange: (s: Section) => void
}): JSX.Element {
  const options: { key: Section; label: string }[] = [
    { key: 'review', label: 'Review' },
    { key: 'lessons', label: 'Lessons' },
    { key: 'progress', label: 'Progress' }
  ]
  return (
    <div className="segmented-control" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          role="tab"
          aria-selected={section === opt.key}
          className={
            section === opt.key ? 'segmented-option segmented-option-active' : 'segmented-option'
          }
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function ReviewSection({
  dueTopics,
  now,
  onStudentMessage
}: {
  dueTopics: TopicStatus[]
  now: Date
  onStudentMessage: (text: string) => void
}): JSX.Element {
  if (dueTopics.length === 0) {
    return <div className="study-empty">Nothing due for review — nice work.</div>
  }

  const targets = dueTopics.slice(0, MAX_REVIEW_TOPICS)

  const handleReview = (): void => {
    const list = targets.map((t) => t.topic).join(', ')
    onStudentMessage(
      `I'd like a review session on these topics: ${list}. Please quiz me before re-teaching.`
    )
  }

  return (
    <div className="review-section">
      <button type="button" className="review-now-btn" onClick={handleReview}>
        Review these now
      </button>
      <div className="due-list">
        {dueTopics.map((topic) => {
          const latestNote = topic.notes[topic.notes.length - 1]
          return (
            <div key={topic.topic.toLowerCase()} className="due-row">
              <div className="due-row-header">
                <span className="due-row-topic">{topic.topic}</span>
                <MasteryBadge mastery={topic.mastery} />
              </div>
              <div className="due-row-meta">{daysAgoLabel(topic.lastNoteAt, now)}</div>
              {latestNote !== undefined && (
                <div className="due-row-note">{latestNote.note}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LessonRow({
  lesson,
  onSelect
}: {
  lesson: Lesson
  onSelect: (id: string) => void
}): JSX.Element {
  return (
    <button type="button" className="lesson-row" onClick={() => onSelect(lesson.id)}>
      <div className="lesson-row-main">
        <span className="lesson-row-title">{lesson.title}</span>
        <div className="topic-chips">
          {lesson.topics.map((topic) => (
            <span key={topic} className="topic-chip">
              {topic}
            </span>
          ))}
        </div>
        <span className="lesson-row-date">{formatDate(lesson.createdAt)}</span>
      </div>
      <span className={`lesson-status-badge lesson-status-${lesson.status}`}>
        {STATUS_LABELS[lesson.status]}
      </span>
    </button>
  )
}

function LessonDetail({
  lesson,
  onBack,
  onStudentMessage
}: {
  lesson: Lesson
  onBack: () => void
  onStudentMessage: (text: string) => void
}): JSX.Element {
  const handleContinue = (): void => {
    onStudentMessage(
      `Let's continue the lesson "${lesson.title}". Check my progress notes first and pick up where we left off.`
    )
  }

  return (
    <div className="lesson-detail">
      <button type="button" className="interview-back-btn" onClick={onBack}>
        ← All lessons
      </button>

      <div className="lesson-detail-header">
        <div className="lesson-detail-heading">
          <h2 className="lesson-detail-title">{lesson.title}</h2>
          <div className="topic-chips">
            {lesson.topics.map((topic) => (
              <span key={topic} className="topic-chip">
                {topic}
              </span>
            ))}
          </div>
          <span className="interview-detail-meta">{formatDate(lesson.createdAt)}</span>
        </div>
        <span className={`lesson-status-badge lesson-status-${lesson.status}`}>
          {STATUS_LABELS[lesson.status]}
        </span>
      </div>

      <div className="lesson-detail-body markdown-body">
        <ReactMarkdown>{lesson.contentMd}</ReactMarkdown>
      </div>

      <button type="button" className="review-now-btn lesson-continue-btn" onClick={handleContinue}>
        Continue this lesson
      </button>
    </div>
  )
}

function LessonsSection({
  lessons,
  onStudentMessage
}: {
  lessons: Lesson[]
  onStudentMessage: (text: string) => void
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = selectedId !== null ? lessons.find((l) => l.id === selectedId) ?? null : null

  if (selected !== null) {
    return (
      <LessonDetail
        lesson={selected}
        onBack={() => setSelectedId(null)}
        onStudentMessage={onStudentMessage}
      />
    )
  }

  if (lessons.length === 0) {
    return (
      <div className="study-empty">
        No lesson plans yet — agree on a learning goal with your tutor.
      </div>
    )
  }

  return (
    <div className="lessons-list">
      {lessons.map((lesson) => (
        <LessonRow key={lesson.id} lesson={lesson} onSelect={setSelectedId} />
      ))}
    </div>
  )
}

function ProgressRow({ topic }: { topic: TopicStatus }): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="progress-row-wrap">
      <button
        type="button"
        className="progress-row"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="progress-row-main">
          <span className="progress-row-topic">{topic.topic}</span>
          <span className="progress-row-meta">
            {topic.noteCount} note{topic.noteCount === 1 ? '' : 's'} ·{' '}
            {formatDate(topic.lastNoteAt)}
          </span>
        </div>
        <MasteryBadge mastery={topic.mastery} />
      </button>
      {expanded && (
        <div className="progress-history">
          {topic.notes.map((note) => (
            <div key={note.id} className="progress-history-item">
              <div className="progress-history-item-header">
                <span className="progress-history-date">{formatDate(note.createdAt)}</span>
                <MasteryBadge mastery={note.mastery} />
              </div>
              <div className="progress-history-note">{note.note}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProgressSection({ topics }: { topics: TopicStatus[] }): JSX.Element {
  if (topics.length === 0) {
    return (
      <div className="study-empty">
        No progress notes yet — your tutor will track mastery as you learn.
      </div>
    )
  }

  return (
    <div className="progress-list">
      {topics.map((topic) => (
        <ProgressRow key={topic.topic.toLowerCase()} topic={topic} />
      ))}
    </div>
  )
}

export default function LibraryPane({ onStudentMessage }: LibraryPaneProps): JSX.Element {
  const [lessons, setLessons] = useState<Lesson[] | null>(null)
  const [progress, setProgress] = useState<ProgressNote[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState<Section | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([window.tutor.listLessons(), window.tutor.listProgress()])
      .then(([lessonList, progressList]) => {
        if (cancelled) return
        setLessons(lessonList)
        setProgress(progressList)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load library data.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const topics = useMemo(() => (progress !== null ? summarizeTopics(progress) : []), [progress])
  const dueTopics = useMemo(() => dueForReview(topics, new Date()), [topics])

  // Default to Review when something's due, else Lessons — but only decide once,
  // after data has loaded, so we don't flash the wrong default while loading.
  useEffect(() => {
    if (section === null && progress !== null && lessons !== null) {
      setSection(dueTopics.length > 0 ? 'review' : 'lessons')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, lessons])

  if (error !== null) {
    return <div className="study-empty">{error}</div>
  }

  if (lessons === null || progress === null || section === null) {
    return <div className="study-empty">Loading…</div>
  }

  return (
    <div className="library-pane">
      <SegmentedControl section={section} onChange={setSection} />
      <div className="library-section-body">
        {section === 'review' && (
          <ReviewSection dueTopics={dueTopics} now={new Date()} onStudentMessage={onStudentMessage} />
        )}
        {section === 'lessons' && (
          <LessonsSection lessons={lessons} onStudentMessage={onStudentMessage} />
        )}
        {section === 'progress' && <ProgressSection topics={topics} />}
      </div>
    </div>
  )
}
