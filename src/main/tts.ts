import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import type { TutorEvent } from '../shared/types'

// A sentence ends at ./!/?/… optionally followed by a closing quote/bracket, then whitespace.
const SENTENCE_END = /[.!?…]["'”’)\]]*\s+/

function sanitize(text: string): string {
  return text
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasContent(text: string): boolean {
  return /[a-z0-9]/i.test(text)
}

export class Speaker {
  private enabled = false
  private buffer = ''
  private queue: string[] = []
  private current: ChildProcess | null = null
  private speaking = false
  private lastSessionId = ''

  /** notify pushes speaking-state events to the renderer (never back into onTutorEvent). */
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
      this.enqueue(sentence)
    }
  }

  private enqueue(sentence: string): void {
    this.queue.push(sentence)
    if (!this.current) {
      this.pump()
    }
  }

  private pump(): void {
    if (this.queue.length === 0) {
      this.current = null
      this.setSpeaking(false)
      return
    }
    // Speak everything queued as ONE utterance. A per-sentence `say` process
    // adds a mechanical gap between every sentence (audio device open/close)
    // and loses inter-sentence prosody; batching means a new process is only
    // needed when speech has fully caught up with generation.
    //
    // Within the utterance, `say` pauses ~0.66s after every period (measured)
    // vs ~0.22s for a semicolon — so mid-passage periods become semicolons for
    // a natural conversational flow. The final sentence keeps its period for
    // proper end-of-passage cadence, and ?/! are preserved everywhere since
    // their intonation carries meaning.
    const parts = this.queue.splice(0)
    const next = parts
      .map((sentence, i) => (i < parts.length - 1 ? sentence.replace(/\.$/, ';') : sentence))
      .join(' ')
    this.setSpeaking(true)

    const args: string[] = []
    if (process.env['SAY_VOICE']) {
      args.push('-v', process.env['SAY_VOICE'])
    }
    args.push('-r', process.env['SAY_RATE'] ?? '190')
    args.push('--', next)

    const child = spawn('/usr/bin/say', args)
    this.current = child

    const advance = (): void => {
      if (this.current === child) {
        this.current = null
        this.pump()
      }
    }
    child.on('error', advance)
    child.on('exit', advance)
  }

  stop(): void {
    this.queue = []
    if (this.current) {
      this.current.kill('SIGTERM')
    }
    this.current = null
    this.setSpeaking(false)
  }
}
