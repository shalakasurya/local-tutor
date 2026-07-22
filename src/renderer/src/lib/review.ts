// Pure helpers for the Library pane's spaced-review logic. No side effects, no
// imports beyond shared domain types, so this stays trivially unit-testable.
import type { ProgressNote } from '../../../shared/types'

export interface TopicStatus {
  topic: string
  mastery: ProgressNote['mastery']
  lastNoteAt: string
  noteCount: number
  notes: ProgressNote[]
}

/** Days a topic can go untouched before it's due for review, by current mastery. */
const REVIEW_THRESHOLD_DAYS: Record<ProgressNote['mastery'], number> = {
  struggling: 1,
  learning: 3,
  solid: 7
}

/** Order used to rank mastery severity when sorting due topics (lower = more urgent). */
const MASTERY_RANK: Record<ProgressNote['mastery'], number> = {
  struggling: 0,
  learning: 1,
  solid: 2
}

/**
 * Groups progress notes by topic (case-insensitive, trimmed), using the most
 * recently written casing for display. The latest note (by createdAt) sets
 * the topic's current mastery and lastNoteAt. Notes within each topic are
 * sorted oldest -> newest; the returned topics are sorted by lastNoteAt
 * descending (most recently touched first).
 */
export function summarizeTopics(notes: ProgressNote[]): TopicStatus[] {
  interface Bucket {
    displayTopic: string
    displayAt: string
    notes: ProgressNote[]
  }

  const buckets = new Map<string, Bucket>()

  for (const note of notes) {
    const key = note.topic.trim().toLowerCase()
    if (key.length === 0) continue
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { displayTopic: note.topic.trim(), displayAt: note.createdAt, notes: [] }
      buckets.set(key, bucket)
    }
    bucket.notes.push(note)
    // Track the casing from whichever note is currently latest.
    if (note.createdAt >= bucket.displayAt) {
      bucket.displayTopic = note.topic.trim()
      bucket.displayAt = note.createdAt
    }
  }

  const topics: TopicStatus[] = []
  for (const bucket of buckets.values()) {
    const sorted = [...bucket.notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const latest = sorted[sorted.length - 1]
    topics.push({
      topic: bucket.displayTopic,
      mastery: latest.mastery,
      lastNoteAt: latest.createdAt,
      noteCount: sorted.length,
      notes: sorted
    })
  }

  topics.sort((a, b) => b.lastNoteAt.localeCompare(a.lastNoteAt))
  return topics
}

/**
 * Filters topics to those due for review given `now`: a topic is due when the
 * number of days since its lastNoteAt is >= the threshold for its current
 * mastery. Results are sorted by urgency (struggling, then learning, then
 * solid) and within each group by lastNoteAt ascending (staleest first).
 */
export function dueForReview(topics: TopicStatus[], now: Date): TopicStatus[] {
  const due = topics.filter((t) => {
    const last = new Date(t.lastNoteAt)
    if (Number.isNaN(last.getTime())) return false
    const daysSince = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24)
    return daysSince >= REVIEW_THRESHOLD_DAYS[t.mastery]
  })

  due.sort((a, b) => {
    const rankDiff = MASTERY_RANK[a.mastery] - MASTERY_RANK[b.mastery]
    if (rankDiff !== 0) return rankDiff
    return a.lastNoteAt.localeCompare(b.lastNoteAt)
  })

  return due
}
