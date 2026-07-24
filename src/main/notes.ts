import Anthropic from '@anthropic-ai/sdk'
import type { DbApi, TutorEvent } from '../shared/types'

// Note-taking runs on a cheap model — it's distillation, not teaching.
const NOTES_MODEL = process.env.NOTES_MODEL ?? 'claude-haiku-4-5'
const SYNC_DEBOUNCE_MS = 15_000
const MAX_SLICE_CHARS = 24_000

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          content_md: { type: 'string' }
        },
        required: ['topic', 'content_md'],
        additionalProperties: false
      }
    },
    flashcards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          front_md: { type: 'string' },
          back_md: { type: 'string' }
        },
        required: ['topic', 'front_md', 'back_md'],
        additionalProperties: false
      }
    }
  },
  required: ['entries', 'flashcards'],
  additionalProperties: false
} as const

const NOTE_TAKER_PROMPT = `You are the note-taker for a student's personal study notebook. You receive an excerpt of a live tutoring session (student ↔ instructor) and the list of topic sections that already exist in the notebook.

Extract only durable, review-worthy material: concepts and how they work, definitions, code idioms (short fenced code blocks welcome), mistakes the student made and the correction, interview techniques and rules of thumb. Write like excellent student notes — terse markdown bullets, concrete, self-contained (readable months later without the transcript).

Rules:
- Reuse an existing topic name whenever the content fits it; create new topics sparingly, with short reusable names ("React Hooks", not "Discussion about useState on Tuesday").
- One entry per distinct concept; 1-5 bullets each. No filler, no chit-chat, no encouragement, no logistics.
- Skip anything already obvious from the existing-topics context or not worth reviewing.
- If the excerpt contains nothing note-worthy, return an empty entries array.

Additionally produce flashcards (0-3 per excerpt) testing retrieval of the most important points: front is a question you would ask the student (specific, answerable without the transcript); back is the concise correct answer (1-3 lines, code allowed). Only card-worthy material — durable concepts, not trivia; empty array if none.`

export interface DistilledNote {
  topic: string
  content_md: string
}

export interface DistilledCard {
  topic: string
  front_md: string
  back_md: string
}

export interface DistillResult {
  entries: DistilledNote[]
  flashcards: DistilledCard[]
}

/**
 * One distillation call: transcript slice in, note entries out.
 * Exported separately from the service so it can be exercised directly.
 */
export async function distillNotes(
  client: Anthropic,
  existingTopics: string[],
  transcriptSlice: string
): Promise<DistillResult> {
  const response = await client.messages.create({
    model: NOTES_MODEL,
    max_tokens: 2000,
    system: NOTE_TAKER_PROMPT,
    output_config: {
      format: { type: 'json_schema', schema: NOTES_SCHEMA as unknown as Record<string, unknown> }
    },
    messages: [
      {
        role: 'user',
        content:
          `Existing notebook topics: ${existingTopics.length > 0 ? existingTopics.join(', ') : '(none yet)'}\n\n` +
          `New session excerpt:\n\n${transcriptSlice}`
      }
    ]
  })
  const text = response.content.find((b) => b.type === 'text')
  if (!text || text.type !== 'text') return { entries: [], flashcards: [] }
  const parsed = JSON.parse(text.text) as { entries?: DistilledNote[]; flashcards?: DistilledCard[] }
  return {
    entries: Array.isArray(parsed.entries)
      ? parsed.entries.filter((e) => e.topic && e.content_md)
      : [],
    flashcards: Array.isArray(parsed.flashcards)
      ? parsed.flashcards.filter((c) => c.topic && c.front_md && c.back_md)
      : []
  }
}

export class NotesService {
  private client: Anthropic | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private syncing = new Set<string>()

  constructor(
    private db: DbApi,
    private emit: (event: TutorEvent) => void
  ) {}

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic()
    return this.client
  }

  /** Debounced per-session note-taking; call on every turn-end. */
  scheduleSync(sessionId: string): void {
    const existing = this.timers.get(sessionId)
    if (existing) clearTimeout(existing)
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId)
        this.syncSession(sessionId).catch((err) => console.error('[notes]', err))
      }, SYNC_DEBOUNCE_MS)
    )
  }

  /** Distill notes from a session's turns beyond the watermark. Returns entries created. */
  async syncSession(sessionId: string): Promise<number> {
    if (this.syncing.has(sessionId)) return 0
    this.syncing.add(sessionId)
    try {
      const watermark = this.db.getNoteWatermark(sessionId)
      const turns = this.db.getTranscript(sessionId).filter((t) => t.id > watermark)
      if (turns.length === 0 || !turns.some((t) => t.role === 'instructor')) return 0

      let slice = turns
        .map((t) => `${t.role === 'student' ? 'Student' : 'Instructor'}: ${t.content}`)
        .join('\n\n')
      if (slice.length > MAX_SLICE_CHARS) {
        slice = slice.slice(-MAX_SLICE_CHARS)
      }

      // Notebooks are per-session: only this session's topics guide filing, so
      // different learning paths never cross-pollinate topic names.
      const sessionTopics = [
        ...new Set(
          this.db
            .listNotes()
            .filter((n) => n.sessionId === sessionId)
            .map((n) => n.topic)
        )
      ]
      const { entries, flashcards } = await distillNotes(this.getClient(), sessionTopics, slice)
      for (const entry of entries) {
        this.db.createNote({
          topic: entry.topic.trim(),
          contentMd: entry.content_md.trim(),
          sessionId
        })
      }
      for (const card of flashcards) {
        this.db.createFlashcard({
          topic: card.topic.trim(),
          frontMd: card.front_md.trim(),
          backMd: card.back_md.trim(),
          sessionId,
          noteId: null
        })
      }
      if (flashcards.length > 0) {
        this.emit({
          type: 'review-due',
          sessionId,
          dueCount: this.db.listDueFlashcards(new Date().toISOString()).length
        })
      }
      // Advance the watermark even when nothing was note-worthy, so the same
      // turns are never re-analyzed.
      this.db.setNoteWatermark(sessionId, turns[turns.length - 1].id)
      if (entries.length > 0) {
        this.emit({ type: 'notes-updated', sessionId, created: entries.length })
      }
      if (entries.length > 0 || flashcards.length > 0) {
        console.log(`[notes] +${entries.length} note(s), +${flashcards.length} card(s) from session ${sessionId.slice(0, 8)}`)
      }
      return entries.length
    } finally {
      this.syncing.delete(sessionId)
    }
  }

  /** Catch up every session (first-open backfill). Sequential to be gentle on rate limits. */
  async backfillAll(): Promise<{ created: number }> {
    let created = 0
    for (const session of this.db.listSessions()) {
      try {
        created += await this.syncSession(session.id)
      } catch (err) {
        console.error('[notes] backfill failed for session', session.id, err)
      }
    }
    return { created }
  }

  /**
   * One-time conversion of a session's EXISTING notes into flashcards (for
   * notes distilled before flashcards shipped). Flagged per session in app_meta.
   */
  async backfillCards(): Promise<number> {
    let created = 0
    for (const session of this.db.listSessions()) {
      const flag = `cards_backfilled_${session.id}`
      if (this.db.getMeta(flag) !== null) continue
      const sessionNotes = this.db.listNotes().filter((n) => n.sessionId === session.id)
      if (sessionNotes.length === 0) continue
      try {
        const notesText = sessionNotes
          .map((n) => `## ${n.topic}\n${n.contentMd}`)
          .join('\n\n')
        const { flashcards } = await distillNotes(
          this.getClient(),
          [],
          `These are the student's existing study notes. Produce flashcards from them (1-2 per distinct concept). Return an empty entries array — notes already exist.

${notesText}`
        )
        for (const card of flashcards) {
          this.db.createFlashcard({
            topic: card.topic.trim(),
            frontMd: card.front_md.trim(),
            backMd: card.back_md.trim(),
            sessionId: session.id,
            noteId: null
          })
        }
        created += flashcards.length
        this.db.setMeta(flag, new Date().toISOString())
        if (flashcards.length > 0) {
          console.log(`[notes] +${flashcards.length} backfilled card(s) for session ${session.id.slice(0, 8)}`)
        }
      } catch (err) {
        console.error('[notes] card backfill failed for session', session.id, err)
      }
    }
    if (created > 0) {
      this.emit({
        type: 'review-due',
        sessionId: '',
        dueCount: this.db.listDueFlashcards(new Date().toISOString()).length
      })
    }
    return created
  }
}
