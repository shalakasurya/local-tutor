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

function sanitize(text: string): string {
  return text
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasContent(text: string): boolean {
  return /[a-z0-9]/i.test(text)
}

/**
 * Text-to-speech via macOS `say` — but synthesized to WAV and PLAYED IN THE
 * RENDERER (WebAudio), not by `say` itself. Routing playback through Chrome
 * gives its acoustic echo canceller the reference signal, so the open mic can
 * hear the student over the tutor's voice (voice barge-in) instead of having
 * to suspend while the tutor speaks.
 *
 * Protocol: emit `tts-audio` {utteranceId, wav} → renderer plays → renderer
 * calls ttsPlaybackEnded(utteranceId) → next utterance. A duration-based
 * timeout advances the queue if the renderer never answers (closed window),
 * and `tts-stop` halts renderer playback on stop()/barge-in.
 */
export class Speaker {
  private enabled = false
  private buffer = ''
  private queue: string[] = []
  private speaking = false
  private lastSessionId = ''
  private busy = false
  /** Bumped on stop(); in-flight synthesis results from an older generation are discarded. */
  private generation = 0
  private synthChild: ChildProcess | null = null
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

  /**
   * Speak text immediately (transcript replay). Deliberately ignores the
   * `enabled` flag — this is an explicit user request, not an automatic reply.
   */
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
    if (sentence && hasContent(sentence)) {
      this.queue.push(sentence)
      if (!this.busy) {
        void this.pump()
      }
    }
  }

  /** Called (via IPC) when the renderer finished playing an utterance. */
  playbackEnded(utteranceId: string): void {
    if (this.awaiting?.id !== utteranceId) return
    clearTimeout(this.awaiting.timer)
    this.awaiting = null
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.queue.length === 0) {
      this.busy = false
      this.setSpeaking(false)
      return
    }
    this.busy = true
    const gen = this.generation

    // Speak everything queued as ONE utterance for natural flow. `say` pauses
    // ~0.66s after periods (measured) vs ~0.22s for semicolons, so mid-passage
    // periods become semicolons; the final sentence keeps its cadence.
    const parts = this.queue.splice(0)
    const text = parts
      .map((sentence, i) => (i < parts.length - 1 ? sentence.replace(/\.$/, ';') : sentence))
      .join(' ')

    let wav: Buffer
    try {
      wav = await this.synthesize(text)
    } catch {
      if (gen === this.generation) void this.pump() // skip the failed utterance
      return
    }
    if (gen !== this.generation) return // stopped while synthesizing

    this.setSpeaking(true)
    const utteranceId = randomUUID()
    const wavBuffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength)
    this.notify({
      type: 'tts-audio',
      sessionId: this.lastSessionId,
      utteranceId,
      wav: wavBuffer as ArrayBuffer
    })

    // Fallback: if the renderer never reports back (window closed mid-speech),
    // advance after the utterance's estimated duration plus grace.
    const estimatedMs = (wav.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000 + 3000
    this.awaiting = {
      id: utteranceId,
      timer: setTimeout(() => {
        if (this.awaiting?.id === utteranceId) {
          this.awaiting = null
          void this.pump()
        }
      }, estimatedMs)
    }
  }

  private async synthesize(text: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'tutor-tts-'))
    const file = join(dir, 'utterance.wav')
    try {
      await new Promise<void>((resolve, reject) => {
        const args: string[] = ['-o', file, `--data-format=LEI16@${SAMPLE_RATE}`]
        if (process.env['SAY_VOICE']) {
          args.push('-v', process.env['SAY_VOICE'])
        }
        args.push('-r', process.env['SAY_RATE'] ?? '190')
        args.push('--', text)
        const child = spawn('/usr/bin/say', args)
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
    if (this.synthChild) {
      this.synthChild.kill('SIGTERM')
      this.synthChild = null
    }
    if (this.awaiting) {
      clearTimeout(this.awaiting.timer)
      this.awaiting = null
    }
    this.busy = false
    this.notify({ type: 'tts-stop', sessionId: this.lastSessionId })
    this.setSpeaking(false)
  }
}
