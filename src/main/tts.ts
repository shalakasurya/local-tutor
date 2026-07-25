import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TutorEvent } from '../shared/types'

// A sentence ends at ./!/?/… optionally followed by a closing quote/bracket, then whitespace.
const SENTENCE_END = /[.!?…]["'”’)\]]*\s+/

const SAMPLE_RATE = 22050
const BYTES_PER_SAMPLE = 2
/** Renderer-path batches stay small so synthesis (≈ real-time) overlaps playback well. */
const RENDERER_BATCH_CHARS = 300
/** Keep up to this many synthesized utterances ready ahead of playback. */
const PREFETCH_DEPTH = 2

function sanitize(text: string): string {
  return text
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasContent(text: string): boolean {
  return /[a-z0-9]/i.test(text)
}

function sayArgs(): string[] {
  const args: string[] = []
  if (process.env['SAY_VOICE']) {
    args.push('-v', process.env['SAY_VOICE'])
  }
  args.push('-r', process.env['SAY_RATE'] ?? '190')
  return args
}

/** Joins sentences into one utterance; mid-passage periods become semicolons
 *  (measured: `say` pauses ~0.66s after periods vs ~0.22s for semicolons). */
function joinForSpeech(parts: string[]): string {
  return parts
    .map((sentence, i) => (i < parts.length - 1 ? sentence.replace(/\.$/, ';') : sentence))
    .join(' ')
}

/**
 * Text-to-speech via macOS `say`, with two output routes:
 *
 * - 'direct' (default): `say` plays the audio itself — speech starts instantly.
 *   Used whenever the hands-free open mic is NOT live (no echo problem exists).
 * - 'renderer': synthesize to WAV and play through the renderer's WebAudio so
 *   Chrome's echo canceller can subtract the tutor's voice from the open mic
 *   (voice barge-in). File synthesis runs ≈ real-time, so this path pipelines:
 *   the next utterance synthesizes while the current one plays, and batches are
 *   small — only the first utterance pays noticeable latency.
 *
 * The renderer toggles the route via setMicOpen() as hands-free turns on/off.
 */
export class Speaker {
  private enabled = false
  private buffer = ''
  private queue: string[] = []
  private speaking = false
  private lastSessionId = ''
  private mode: 'direct' | 'renderer' = 'direct'
  /** Bumped on stop(); in-flight work from an older generation is discarded. */
  private generation = 0

  // direct path
  private playChild: ChildProcess | null = null
  private directBusy = false

  // renderer path
  private synthChild: ChildProcess | null = null
  private synthBusy = false
  private ready: Array<{ id: string; wav: Buffer }> = []
  private shipping = false
  private awaiting: { id: string; timer: NodeJS.Timeout } | null = null

  /** notify pushes speaking-state and audio events to the renderer (never back into onTutorEvent). */
  constructor(private notify: (event: TutorEvent) => void = () => {}) {}

  private setSpeaking(active: boolean): void {
    if (this.speaking === active) return
    this.speaking = active
    this.notify({ type: 'speaking', sessionId: this.lastSessionId, active })
  }

  status(): { available: boolean; reason?: string } {
    if (process.platform !== 'darwin') {
      return { available: false, reason: 'text-to-speech currently requires macOS' }
    }
    return { available: true }
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) this.stop()
  }

  /** Hands-free open mic live? Route through the renderer for echo cancellation. */
  setMicOpen(open: boolean): void {
    const next = open ? 'renderer' : 'direct'
    if (next === this.mode) return
    // Mid-speech route changes restart cleanly rather than mixing outputs.
    if (this.speaking || this.queue.length > 0) this.stop()
    this.mode = next
  }

  /** Speak text immediately (transcript replay). Ignores the `enabled` flag. */
  speakNow(text: string): void {
    if (process.platform !== 'darwin') return
    this.stop()
    this.buffer = ''
    let rest = text
    let match: RegExpMatchArray | null
    while ((match = rest.match(SENTENCE_END))) {
      const idx = match.index! + match[0].length
      this.enqueueSanitized(rest.slice(0, idx))
      rest = rest.slice(idx)
    }
    this.enqueueSanitized(rest)
  }

  onTutorEvent(event: TutorEvent): void {
    if (!this.enabled || process.platform !== 'darwin') return

    switch (event.type) {
      case 'turn-start':
        this.lastSessionId = event.sessionId
        this.stop()
        this.buffer = ''
        break

      case 'delta': {
        this.buffer += event.text
        let match: RegExpMatchArray | null
        while ((match = this.buffer.match(SENTENCE_END))) {
          const idx = match.index! + match[0].length
          const sentence = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx)
          this.enqueueSanitized(sentence)
        }
        break
      }

      case 'turn-end':
        this.enqueueSanitized(this.buffer)
        this.buffer = ''
        break

      case 'error':
        this.stop()
        break
    }
  }

  private enqueueSanitized(raw: string): void {
    const sentence = sanitize(raw)
    if (!sentence || !hasContent(sentence)) return
    this.queue.push(sentence)
    if (this.mode === 'direct') {
      if (!this.directBusy) void this.directPump()
    } else {
      void this.synthLoop()
    }
  }

  // ---------- Direct route: say plays the audio, speech starts instantly ----------

  private async directPump(): Promise<void> {
    if (this.queue.length === 0) {
      this.directBusy = false
      this.setSpeaking(false)
      return
    }
    this.directBusy = true
    const gen = this.generation
    const text = joinForSpeech(this.queue.splice(0))
    this.setSpeaking(true)
    await new Promise<void>((resolve) => {
      const child = spawn('/usr/bin/say', [...sayArgs(), '--', text])
      this.playChild = child
      const done = (): void => {
        if (this.playChild === child) this.playChild = null
        resolve()
      }
      child.on('error', done)
      child.on('exit', done)
    })
    if (gen !== this.generation) return
    void this.directPump()
  }

  // ---------- Renderer route: synthesize → ship → WebAudio (echo-cancelled) ----------

  private async synthLoop(): Promise<void> {
    if (this.synthBusy) return
    this.synthBusy = true
    const gen = this.generation
    try {
      while (this.queue.length > 0 && this.ready.length < PREFETCH_DEPTH) {
        // Small batches keep synthesis (≈ real-time) overlapping playback.
        const parts: string[] = []
        let chars = 0
        while (this.queue.length > 0 && (parts.length === 0 || chars < RENDERER_BATCH_CHARS)) {
          const next = this.queue[0]
          if (parts.length > 0 && chars + next.length > RENDERER_BATCH_CHARS) break
          parts.push(this.queue.shift()!)
          chars += next.length
        }
        const text = joinForSpeech(parts)
        let wav: Buffer
        try {
          wav = await this.synthesize(text)
        } catch {
          continue // skip a failed utterance
        }
        if (gen !== this.generation) return
        this.ready.push({ id: randomUUID(), wav })
        if (!this.shipping) void this.shipNext()
      }
    } finally {
      this.synthBusy = false
      // More may have queued while we were over the prefetch cap.
      if (gen === this.generation && this.queue.length > 0 && this.ready.length < PREFETCH_DEPTH) {
        void this.synthLoop()
      }
    }
  }

  private shipNext(): void {
    const item = this.ready.shift()
    if (!item) {
      this.shipping = false
      if (this.queue.length === 0 && !this.synthBusy) this.setSpeaking(false)
      return
    }
    this.shipping = true
    this.setSpeaking(true)
    const wavBuffer = item.wav.buffer.slice(
      item.wav.byteOffset,
      item.wav.byteOffset + item.wav.byteLength
    )
    this.notify({
      type: 'tts-audio',
      sessionId: this.lastSessionId,
      utteranceId: item.id,
      wav: wavBuffer as ArrayBuffer
    })
    // Refill the prefetch buffer while this plays.
    void this.synthLoop()
    // Fallback if the renderer never reports back (window closed mid-speech).
    const estimatedMs = (item.wav.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000 + 3000
    this.awaiting = {
      id: item.id,
      timer: setTimeout(() => {
        if (this.awaiting?.id === item.id) {
          this.awaiting = null
          this.shipNext()
        }
      }, estimatedMs)
    }
  }

  /** Called (via IPC) when the renderer finished playing an utterance. */
  playbackEnded(utteranceId: string): void {
    if (this.awaiting?.id !== utteranceId) return
    clearTimeout(this.awaiting.timer)
    this.awaiting = null
    this.shipNext()
  }

  private async synthesize(text: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'tutor-tts-'))
    const file = join(dir, 'utterance.wav')
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('/usr/bin/say', [
          '-o',
          file,
          `--data-format=LEI16@${SAMPLE_RATE}`,
          ...sayArgs(),
          '--',
          text
        ])
        this.synthChild = child
        child.on('error', reject)
        child.on('exit', (code) => {
          if (this.synthChild === child) this.synthChild = null
          code === 0 ? resolve() : reject(new Error(`say exited with ${code}`))
        })
      })
      return await readFile(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  stop(): void {
    this.generation++
    this.queue = []
    this.ready = []
    if (this.playChild) {
      this.playChild.kill('SIGTERM')
      this.playChild = null
    }
    if (this.synthChild) {
      this.synthChild.kill('SIGTERM')
      this.synthChild = null
    }
    if (this.awaiting) {
      clearTimeout(this.awaiting.timer)
      this.awaiting = null
    }
    this.directBusy = false
    this.synthBusy = false
    this.shipping = false
    this.notify({ type: 'tts-stop', sessionId: this.lastSessionId })
    this.setSpeaking(false)
  }
}
