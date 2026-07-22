// Microphone capture producing a 16kHz mono 16-bit PCM WAV ArrayBuffer.
// No external dependencies — uses the Web Audio API's ScriptProcessorNode
// (deprecated but universally supported and simplest for a fixed-format capture).

export class MicRecorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []
  private sampleCount = 0
  private sampleRate = 16000
  private isRecording = false

  get recording(): boolean {
    return this.isRecording
  }

  get durationMs(): number {
    return (this.sampleCount / this.sampleRate) * 1000
  }

  async start(): Promise<void> {
    if (this.isRecording) {
      throw new Error('Recording already in progress')
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
    const processor = context.createScriptProcessor(4096, 1, 1)

    this.chunks = []
    this.sampleCount = 0
    this.sampleRate = context.sampleRate

    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      const input = event.inputBuffer.getChannelData(0)
      const copy = input.slice()
      this.chunks.push(copy)
      this.sampleCount += copy.length
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
    this.isRecording = true
  }

  stop(): ArrayBuffer {
    const sampleRate = this.sampleRate
    const chunks = this.chunks
    this.teardown()

    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Float32Array(totalSamples)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    return encodeWav(merged, sampleRate)
  }

  cancel(): void {
    this.teardown()
    this.chunks = []
    this.sampleCount = 0
  }

  private teardown(): void {
    this.isRecording = false

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
