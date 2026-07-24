// Renderer-side playback of TTS audio synthesized by the main process.
//
// Main no longer plays audio itself: it synthesizes a WAV per utterance and sends
// it here over the event channel. Playing it through this tab's WebAudio graph
// (rather than natively in main) means it goes out the same output device Chrome
// is aware of, so the echo canceller on getUserMedia can subtract the tutor's
// voice from the open mic — enabling voice barge-in.

export class TtsPlayer {
  private context: AudioContext | null = null
  private currentSource: AudioBufferSourceNode | null = null

  private getContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext()
    }
    return this.context
  }

  async play(
    utteranceId: string,
    wav: ArrayBuffer,
    onEnded: (id: string) => void
  ): Promise<void> {
    this.stop()

    const context = this.getContext()
    try {
      if (context.state === 'suspended') {
        await context.resume()
      }
      // decodeAudioData detaches the buffer it's given, so hand it a copy.
      const audioBuffer = await context.decodeAudioData(wav.slice(0))

      const source = context.createBufferSource()
      source.buffer = audioBuffer
      source.connect(context.destination)
      source.onended = (): void => {
        if (this.currentSource === source) {
          this.currentSource = null
          onEnded(utteranceId)
        }
      }

      this.currentSource = source
      source.start()
    } catch {
      // Playback failed — still tell main so its playback queue advances.
      onEnded(utteranceId)
    }
  }

  stop(): void {
    const source = this.currentSource
    this.currentSource = null
    if (source) {
      try {
        source.onended = null
        source.stop()
        source.disconnect()
      } catch {
        // source may never have been started; ignore.
      }
    }
  }
}
