import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Flashcard, Lesson, ProgressNote } from '../../../shared/types'
import { dueForReview, summarizeTopics } from '../lib/review'
import type { TopicStatus } from '../lib/review'

interface LibraryPaneProps {
  onStudentMessage: (text: string) => void
  /** Registers (on mount) / unregisters (on unmount, via null) a listFlashcards-only
   *  refresh callback that App invokes when a 'review-due' event arrives while this
   *  pane is open (mirrors NotesView's registerRefresh). */
  registerRefresh?: (cb: (() => void) | null) => void
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

/** Relative "due" label for a flashcard chip: "due now" once dueAt has passed,
 *  otherwise a short "due in Xh" / "due in 1 day" / "due in N days" countdown. */
function dueLabel(dueAt: string, now: Date): string {
  const due = Date.parse(dueAt)
  if (Number.isNaN(due)) return 'due now'
  const diffMs = due - now.getTime()
  if (diffMs <= 0) return 'due now'
  const diffHours = Math.round(diffMs / (1000 * 60 * 60))
  if (diffHours < 1) return 'due in <1h'
  if (diffHours < 24) return `due in ${diffHours}h`
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  return diffDays === 1 ? 'due in 1 day' : `due in ${diffDays} days`
}

function isCardDue(card: Flashcard, now: Date): boolean {
  const due = Date.parse(card.dueAt)
  return !Number.isNaN(due) && due <= now.getTime()
}

interface TopicDeckGroup {
  topic: string
  cards: Flashcard[]
}

/** Groups flashcards by topic (as-authored, no case-folding — flashcard topics are
 *  tutor-assigned and expected to already be consistent), preserving nothing about
 *  order beyond grouping; callers sort. */
function groupCardsByTopic(cards: Flashcard[]): TopicDeckGroup[] {
  const map = new Map<string, Flashcard[]>()
  for (const card of cards) {
    const list = map.get(card.topic)
    if (list) {
      list.push(card)
    } else {
      map.set(card.topic, [card])
    }
  }
  return Array.from(map.entries()).map(([topic, topicCards]) => ({ topic, cards: topicCards }))
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

function CardRow({
  card,
  now,
  onDelete
}: {
  card: Flashcard
  now: Date
  onDelete: (id: string) => void
}): JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const due = isCardDue(card, now)

  const handleDelete = (e: MouseEvent): void => {
    e.stopPropagation()
    if (window.confirm('Delete this flashcard?')) {
      onDelete(card.id)
    }
  }

  return (
    <div className="card-row">
      <button
        type="button"
        className="card-row-toggle"
        aria-expanded={revealed}
        onClick={() => setRevealed((v) => !v)}
      >
        <div className="card-row-front">{card.frontMd}</div>
        {revealed && (
          <div className="card-row-back markdown-body">
            <ReactMarkdown>{card.backMd}</ReactMarkdown>
          </div>
        )}
      </button>
      <div className="card-row-meta">
        {card.reps > 0 && (
          <span
            className="card-reps-tag"
            title={card.lapses > 0 ? `${card.lapses} lapse${card.lapses === 1 ? '' : 's'}` : undefined}
          >
            ×{card.reps}
          </span>
        )}
        <span className={due ? 'due-chip due-chip-now' : 'due-chip'}>{dueLabel(card.dueAt, now)}</span>
        <button
          type="button"
          className="card-delete-btn"
          aria-label="Delete flashcard"
          onClick={handleDelete}
        >
          🗑
        </button>
      </div>
    </div>
  )
}

function TopicDeck({
  group,
  now,
  onDeleteCard
}: {
  group: TopicDeckGroup
  now: Date
  onDeleteCard: (id: string) => void
}): JSX.Element {
  const sorted = useMemo(() => {
    const nowMs = now.getTime()
    return [...group.cards].sort((a, b) => {
      const aDue = Date.parse(a.dueAt)
      const bDue = Date.parse(b.dueAt)
      const aIsDue = !Number.isNaN(aDue) && aDue <= nowMs
      const bIsDue = !Number.isNaN(bDue) && bDue <= nowMs
      if (aIsDue !== bIsDue) return aIsDue ? -1 : 1
      return aDue - bDue
    })
  }, [group.cards, now])

  const dueCount = sorted.filter((c) => isCardDue(c, now)).length

  return (
    <details className="deck-topic">
      <summary className="deck-topic-summary">
        <span className="deck-topic-name">{group.topic}</span>
        <span className="deck-topic-count">
          {group.cards.length} card{group.cards.length === 1 ? '' : 's'}
          {dueCount > 0 ? ` · ${dueCount} due` : ''}
        </span>
      </summary>
      <div className="deck-card-list">
        {sorted.map((card) => (
          <CardRow key={card.id} card={card} now={now} onDelete={onDeleteCard} />
        ))}
      </div>
    </details>
  )
}

function DeckBrowser({
  cards,
  now,
  onDeleteCard
}: {
  cards: Flashcard[]
  now: Date
  onDeleteCard: (id: string) => void
}): JSX.Element {
  const groups = useMemo(() => {
    const nowMs = now.getTime()
    const grouped = groupCardsByTopic(cards)
    grouped.sort((a, b) => {
      const aDue = a.cards.filter((c) => isCardDue(c, now)).length
      const bDue = b.cards.filter((c) => isCardDue(c, now)).length
      if (aDue !== bDue) return bDue - aDue
      return a.topic.localeCompare(b.topic)
    })
    return grouped
  }, [cards, now])

  if (cards.length === 0) {
    return (
      <div className="study-empty">
        No flashcards yet — they&apos;ll appear as your tutor creates them.
      </div>
    )
  }

  return (
    <div className="deck-browser">
      {groups.map((group) => (
        <TopicDeck key={group.topic} group={group} now={now} onDeleteCard={onDeleteCard} />
      ))}
    </div>
  )
}

function TopicsAttentionSection({
  dueTopics,
  now,
  onStudentMessage
}: {
  dueTopics: TopicStatus[]
  now: Date
  onStudentMessage: (text: string) => void
}): JSX.Element {
  const targets = dueTopics.slice(0, MAX_REVIEW_TOPICS)

  const handleReview = (): void => {
    const list = targets.map((t) => t.topic).join(', ')
    onStudentMessage(
      `I'd like a review session on these topics: ${list}. Please quiz me before re-teaching.`
    )
  }

  return (
    <div className="topics-attention">
      <h3 className="topics-attention-heading">Topics needing attention</h3>
      {dueTopics.length === 0 ? (
        <div className="study-empty">Nothing due for review — nice work.</div>
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}

function ReviewSection({
  cards,
  dueTopics,
  now,
  onStudentMessage,
  onDeleteCard
}: {
  cards: Flashcard[]
  dueTopics: TopicStatus[]
  now: Date
  onStudentMessage: (text: string) => void
  onDeleteCard: (id: string) => void
}): JSX.Element {
  const dueCount = useMemo(() => cards.filter((c) => isCardDue(c, now)).length, [cards, now])

  const handleReviewCards = (): void => {
    onStudentMessage("Let's review my due flashcards.")
  }

  return (
    <div className="review-section">
      <div className="deck-summary">
        <span className="deck-summary-line">
          {dueCount === 0
            ? 'No cards due — all caught up 🎉'
            : `${dueCount} card${dueCount === 1 ? '' : 's'} due`}
        </span>
        <button
          type="button"
          className="review-now-btn"
          disabled={dueCount === 0}
          onClick={handleReviewCards}
        >
          Review with tutor
        </button>
      </div>

      <DeckBrowser cards={cards} now={now} onDeleteCard={onDeleteCard} />

      <TopicsAttentionSection dueTopics={dueTopics} now={now} onStudentMessage={onStudentMessage} />
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

export default function LibraryPane({
  onStudentMessage,
  registerRefresh
}: LibraryPaneProps): JSX.Element {
  const [lessons, setLessons] = useState<Lesson[] | null>(null)
  const [progress, setProgress] = useState<ProgressNote[] | null>(null)
  const [flashcards, setFlashcards] = useState<Flashcard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState<Section | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([window.tutor.listLessons(), window.tutor.listProgress(), window.tutor.listFlashcards()])
      .then(([lessonList, progressList, flashcardList]) => {
        if (cancelled) return
        setLessons(lessonList)
        setProgress(progressList)
        setFlashcards(flashcardList)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load library data.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // listFlashcards-only reload, exposed to App via registerRefresh so a global
  // 'review-due' event (card created/graded elsewhere) can refresh the deck
  // browser without re-fetching lessons/progress (mirrors NotesView's pattern).
  const reloadFlashcards = useCallback(() => {
    window.tutor
      .listFlashcards()
      .then((list) => setFlashcards(list))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load flashcards.')
      })
  }, [])

  useEffect(() => {
    if (registerRefresh === undefined) return undefined
    registerRefresh(reloadFlashcards)
    return () => registerRefresh(null)
  }, [registerRefresh, reloadFlashcards])

  const handleDeleteCard = useCallback((id: string) => {
    setFlashcards((prev) => (prev === null ? prev : prev.filter((c) => c.id !== id)))
    window.tutor.deleteFlashcard(id).catch((err: unknown) => {
      console.error('Failed to delete flashcard', err)
    })
  }, [])

  const topics = useMemo(() => (progress !== null ? summarizeTopics(progress) : []), [progress])
  const dueTopics = useMemo(() => dueForReview(topics, new Date()), [topics])

  // Default to Review when something's due (either a topic needing attention or a
  // due flashcard), else Lessons — but only decide once, after data has loaded, so
  // we don't flash the wrong default while loading.
  useEffect(() => {
    if (section === null && progress !== null && lessons !== null && flashcards !== null) {
      const dueCardCount = flashcards.filter((c) => isCardDue(c, new Date())).length
      setSection(dueTopics.length > 0 || dueCardCount > 0 ? 'review' : 'lessons')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, lessons, flashcards])

  if (error !== null) {
    return <div className="study-empty">{error}</div>
  }

  if (lessons === null || progress === null || flashcards === null || section === null) {
    return <div className="study-empty">Loading…</div>
  }

  return (
    <div className="library-pane">
      <SegmentedControl section={section} onChange={setSection} />
      <div className="library-section-body">
        {section === 'review' && (
          <ReviewSection
            cards={flashcards}
            dueTopics={dueTopics}
            now={new Date()}
            onStudentMessage={onStudentMessage}
            onDeleteCard={handleDeleteCard}
          />
        )}
        {section === 'lessons' && (
          <LessonsSection lessons={lessons} onStudentMessage={onStudentMessage} />
        )}
        {section === 'progress' && <ProgressSection topics={topics} />}
      </div>
    </div>
  )
}
