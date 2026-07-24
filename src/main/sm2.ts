// SM-2 style spaced-repetition scheduling (the algorithm family Anki uses).
// Pure functions — no Electron, no DB — so the scheduling math is unit-testable.

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy'

export interface SrsState {
  /** Ease factor; starts at 2.5, floor 1.3. */
  ease: number
  /** Current interval in days (0 = learning/new). */
  intervalDays: number
  /** Successful repetitions in a row. */
  reps: number
  /** Times the card was forgotten after being learned. */
  lapses: number
}

export const NEW_CARD_STATE: SrsState = { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0 }

const MIN_EASE = 1.3
const AGAIN_RETRY_MINUTES = 10

export interface GradedState extends SrsState {
  /** When the card is next due, as an ISO timestamp. */
  dueAt: string
}

export function applyGrade(state: SrsState, grade: ReviewGrade, now: Date): GradedState {
  let { ease, intervalDays, reps, lapses } = state

  switch (grade) {
    case 'again':
      // Forgotten: back to learning, retry within the session (10 min).
      if (reps > 0) lapses += 1
      reps = 0
      intervalDays = 0
      ease = Math.max(MIN_EASE, ease - 0.2)
      return { ease, intervalDays, reps, lapses, dueAt: addMinutes(now, AGAIN_RETRY_MINUTES) }

    case 'hard':
      // Barely recalled: small interval growth, ease penalty.
      ease = Math.max(MIN_EASE, ease - 0.15)
      intervalDays = intervalDays === 0 ? 1 : Math.max(intervalDays + 1, intervalDays * 1.2)
      reps += 1
      return { ease, intervalDays, reps, lapses, dueAt: addDays(now, intervalDays) }

    case 'good':
      reps += 1
      if (reps === 1) intervalDays = 1
      else if (reps === 2) intervalDays = 3
      else intervalDays = Math.round(intervalDays * ease * 10) / 10
      return { ease, intervalDays, reps, lapses, dueAt: addDays(now, intervalDays) }

    case 'easy':
      ease += 0.15
      reps += 1
      if (reps === 1) intervalDays = 3
      else if (reps === 2) intervalDays = 5
      else intervalDays = Math.round(intervalDays * ease * 1.3 * 10) / 10
      return { ease, intervalDays, reps, lapses, dueAt: addDays(now, intervalDays) }
  }
}

function addMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}

function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString()
}
