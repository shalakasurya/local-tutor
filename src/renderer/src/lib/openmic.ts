// Continuous ("hands-free") microphone capture with a lightweight energy-based
// voice-activity detector. Reuses the same capture pipeline as MicRecorder
// (getUserMedia -> AudioContext -> ScriptProcessorNode) but instead of a single
// start/stop recording, it segments continuous audio into utterances based on
// speech energy and silence gaps, emitting a WAV per detected utterance.

export type OpenMicState = 'listening' | 'speech' | 'suspended'

interface OpenMicCallbacks {
  onSegment: (wav: ArrayBuffer, durationMs: number) => void
  onState: (state: OpenMicState) => void
}

const FRAME_SIZE = 1024
const PRE_ROLL_FRAMES = 6 // ~380ms at 16kHz/1024-sample frames (~64ms each)
const NOISE_FLOOR_ALPHA = 0.05
const NOISE_FLOOR_INITIAL = 0.005
const MIN_SPEECH_THRESHOLD = 0.012
const SILENCE_HANGOVER_MS = 1200
const MIN_VOICED_MS = 400
const MAX_SEGMENT_MS = 90_000

export class OpenMic {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private callbacks: OpenMicCallbacks | null = null

  private sampleRate = 16000
  private isRunning = false
  private isSuspended = false
  private isSpeaking = false

  private noiseFloor = NOISE_FLOOR_INITIAL
  private preRoll: Float32Array[] = []
  private segmentFrames: Float32Array[] = []
  private silenceMs = 0

  get running(): boolean {
    return this.isRunning
  }

  async start(callbacks: OpenMicCallbacks): Promise<void> {
    if (this.isRunning) {
      throw new Error('OpenMic already running')
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      })
    } catch (err) {
      throw new Error(
        `Microphone access denied: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const context = new AudioContext({ sampleRate: 16000 })
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(FRAME_SIZE, 1, 1)

    this.callbacks = callbacks
    this.sampleRate = context.sampleRate
    this.noiseFloor = NOISE_FLOOR_INITIAL
    this.preRoll = []
    this.segmentFrames = []
    this.silenceMs = 0
    this.isSpeaking = false
    this.isSuspended = false

    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      const input = event.inputBuffer.getChannelData(0)
      this.handleFrame(input.slice())
    }

    source.connect(processor)
    // A ScriptProcessorNode only fires onaudioprocess while connected into the
    // graph's destination path, so we route it there (silently — we never
    // write to the output channels).
    processor.connect(context.destination)

    this.stream = stream
    this.context = context
    this.source = source
    this.processor = processor
    this.isRunning = true

    callbacks.onState('listening')
  }

  suspend(on: boolean): void {
    if (!this.isRunning || this.isSuspended === on) return
    this.isSuspended = on
    if (on) {
      this.preRoll = []
      this.segmentFrames = []
      this.silenceMs = 0
      this.isSpeaking = false
      this.callbacks?.onState('suspended')
    } else {
      this.callbacks?.onState('listening')
    }
  }

  stop(): void {
    this.isRunning = false
    this.isSuspended = false
    this.isSpeaking = false
    this.preRoll = []
    this.segmentFrames = []
    this.silenceMs = 0
    this.callbacks = null

    if (this.processor) {
      this.processor.disconnect()
      this.processor.onaudioprocess = null
      this.processor = null
    }
    if (this.source) {
      this.source.disconnect()
      this.source = null
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop()
      }
      this.stream = null
    }
    if (this.context) {
      void this.context.close()
      this.context = null
    }
  }

  private handleFrame(frame: Float32Array): void {
    if (this.isSuspended || !this.callbacks) return

    const rms = computeRms(frame)
    const frameMs = (frame.length / this.sampleRate) * 1000
    const threshold = Math.max(MIN_SPEECH_THRESHOLD, this.noiseFloor * 3)
    const aboveThreshold = rms > threshold

    if (!this.isSpeaking) {
      if (aboveThreshold) {
        this.isSpeaking = true
        this.segmentFrames = [...this.preRoll, frame]
        this.preRoll = []
        this.silenceMs = 0
        this.callbacks.onState('speech')
      } else {
        this.noiseFloor = this.noiseFloor * (1 - NOISE_FLOOR_ALPHA) + rms * NOISE_FLOOR_ALPHA
        this.preRoll.push(frame)
        if (this.preRoll.length > PRE_ROLL_FRAMES) {
          this.preRoll.shift()
        }
      }
      return
    }

    // In speech: append every frame.
    this.segmentFrames.push(frame)
    this.silenceMs = aboveThreshold ? 0 : this.silenceMs + frameMs

    const segmentMs = totalDurationMs(this.segmentFrames, this.sampleRate)
    if (segmentMs >= MAX_SEGMENT_MS || this.silenceMs >= SILENCE_HANGOVER_MS) {
      this.finalizeSegment()
    }
  }

  private finalizeSegment(): void {
    const frames = this.segmentFrames
    const silenceMs = this.silenceMs

    this.segmentFrames = []
    this.silenceMs = 0
    this.isSpeaking = false

    const merged = mergeFrames(frames)
    const totalMs = (merged.length / this.sampleRate) * 1000
    const voicedMs = totalMs - silenceMs

    if (voicedMs >= MIN_VOICED_MS) {
      const wav = encodeWav(merged, this.sampleRate)
      this.callbacks?.onSegment(wav, totalMs)
    }

    this.callbacks?.onState('listening')
  }
}

function computeRms(frame: Float32Array): number {
  let sumSquares = 0
  for (let i = 0; i < frame.length; i++) {
    sumSquares += frame[i] * frame[i]
  }
  return Math.sqrt(sumSquares / frame.length)
}

function totalDurationMs(frames: Float32Array[], sampleRate: number): number {
  const totalSamples = frames.reduce((sum, frame) => sum + frame.length, 0)
  return (totalSamples / sampleRate) * 1000
}

function mergeFrames(frames: Float32Array[]): Float32Array {
  const totalSamples = frames.reduce((sum, frame) => sum + frame.length, 0)
  const merged = new Float32Array(totalSamples)
  let offset = 0
  for (const frame of frames) {
    merged.set(frame, offset)
    offset += frame.length
  }
  return merged
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bitsPerSample = 16
  const numChannels = 1
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * 2 // 16-bit = 2 bytes per sample

  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')

  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // Subchunk1Size (PCM)
  view.setUint16(20, 1, true) // AudioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)

  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let pos = 44
  for (let i = 0; i < samples.length; i++) {
    const f = samples[i]
    const s = Math.max(-1, Math.min(1, f))
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff
    view.setInt16(pos, int16, true)
    pos += 2
  }

  return buffer
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i))
  }
}
