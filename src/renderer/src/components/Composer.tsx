import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceStatus } from '../../../shared/types'
import { MicRecorder } from '../lib/recorder'
import { OpenMic, type OpenMicState } from '../lib/openmic'

interface ComposerProps {
  streaming: boolean
  onSend: (text: string) => void
  onStop: () => void
  voice: VoiceStatus | null
  onStopSpeaking: () => void
  voiceReplies: boolean
  onVoiceRepliesChange: (on: boolean) => void
  micMode: 'manual' | 'open'
  onMicModeChange: (mode: 'manual' | 'open') => void
  ttsSpeaking: boolean
  onStudentActivity: () => void
}

type VoiceState = 'idle' | 'recording' | 'transcribing'

const HOLD_THRESHOLD_MS = 300

export default function Composer({
  streaming,
  onSend,
  onStop,
  voice,
  onStopSpeaking,
  voiceReplies,
  onVoiceRepliesChange,
  micMode,
  onMicModeChange,
  ttsSpeaking,
  onStudentActivity
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('')
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [hint, setHint] = useState<string | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [openMicState, setOpenMicState] = useState<OpenMicState>('listening')
  const [openMicTranscribing, setOpenMicTranscribing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const recorderRef = useRef<MicRecorder | null>(null)
  const openMicRef = useRef<OpenMic | null>(null)
  const micRequestedRef = useRef(false)

  // Segment transcription queue for hands-free mode (segments can arrive faster
  // than they're transcribed; process them one at a time, in order).
  const segmentQueueRef = useRef<Array<{ wav: ArrayBuffer; durationMs: number }>>([])
  const queueBusyRef = useRef(false)

  // Fresh-value refs so the window-level hotkey listener (subscribed once per
  // voice-availability change) and the OpenMic callbacks (subscribed once per
  // hands-free session) always see current state/props without needing to be
  // re-subscribed on every render.
  const voiceStateRef = useRef(voiceState)
  voiceStateRef.current = voiceState
  const micModeRef = useRef(micMode)
  micModeRef.current = micMode
  const openMicStateRef = useRef(openMicState)
  openMicStateRef.current = openMicState
  const ttsSpeakingRef = useRef(ttsSpeaking)
  ttsSpeakingRef.current = ttsSpeaking
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend
  const onStopSpeakingRef = useRef(onStopSpeaking)
  onStopSpeakingRef.current = onStopSpeaking

  const spacePressStartRef = useRef<number | null>(null)

  const getRecorder = (): MicRecorder => {
    if (!recorderRef.current) {
      recorderRef.current = new MicRecorder()
    }
    return recorderRef.current
  }

  const getOpenMic = (): OpenMic => {
    if (!openMicRef.current) {
      openMicRef.current = new OpenMic()
    }
    return openMicRef.current
  }

  const ensureMicAccess = useCallback(async (): Promise<boolean> => {
    if (micRequestedRef.current) return true
    try {
      micRequestedRef.current = true
      const granted = await window.tutor.requestMicAccess()
      if (!granted) {
        setVoiceError('Microphone access denied')
      }
      return granted
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Microphone access failed')
      return false
    }
  }, [])

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])

  const send = useCallback(() => {
    const trimmed = text.trim()
    if (trimmed === '' || streaming) return
    onStopSpeaking()
    onSend(trimmed)
    setText('')
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
    }
  }, [text, streaming, onSend, onStopSpeaking])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  // ---------- Manual voice input (mic button / hotkey tap-toggle / push-to-talk) ----------

  const startRecording = useCallback(async () => {
    setHint(null)
    setVoiceError(null)
    onStopSpeaking()
    onStudentActivity()
    if (streaming) {
      onStop()
    }
    try {
      const granted = await ensureMicAccess()
      if (!granted) return
      await getRecorder().start()
      setVoiceState('recording')
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Could not start recording')
      setVoiceState('idle')
    }
  }, [onStop, onStopSpeaking, streaming, ensureMicAccess, onStudentActivity])

  const stopRecordingAndTranscribe = useCallback(async () => {
    setHint(null)
    setVoiceError(null)
    const wav = getRecorder().stop()
    setVoiceState('transcribing')
    try {
      const text = await window.tutor.transcribe(wav)
      const trimmed = text.trim()
      if (trimmed !== '') {
        onStopSpeaking()
        onSend(trimmed)
      } else {
        setHint("Didn't catch that — try again")
      }
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Transcription failed')
    } finally {
      setVoiceState('idle')
    }
  }, [onSend, onStopSpeaking])

  const startRecordingRef = useRef(startRecording)
  startRecordingRef.current = startRecording
  const stopRecordingRef = useRef(stopRecordingAndTranscribe)
  stopRecordingRef.current = stopRecordingAndTranscribe

  // ---------- Hands-free (open-mic) mode ----------

  const processSegmentQueue = useCallback(async () => {
    if (queueBusyRef.current) return
    queueBusyRef.current = true
    setOpenMicTranscribing(true)
    try {
      while (segmentQueueRef.current.length > 0) {
        const segment = segmentQueueRef.current.shift()
        if (!segment) continue
        try {
          const text = await window.tutor.transcribe(segment.wav)
          const trimmed = text.trim()
          if (trimmed !== '') {
            onStopSpeakingRef.current()
            onSendRef.current(trimmed)
          }
        } catch (err) {
          setVoiceError(err instanceof Error ? err.message : 'Transcription failed')
        }
      }
    } finally {
      queueBusyRef.current = false
      setOpenMicTranscribing(false)
    }
  }, [])

  const handleOpenMicSegment = useCallback(
    (wav: ArrayBuffer, durationMs: number) => {
      segmentQueueRef.current.push({ wav, durationMs })
      void processSegmentQueue()
    },
    [processSegmentQueue]
  )

  const handleOpenMicState = useCallback((state: OpenMicState) => {
    setOpenMicState(state)
  }, [])

  // Manual mute must survive TTS speaking transitions, so track it explicitly:
  // the mic is suspended when EITHER the user muted it or the tutor is speaking.
  const mutedRef = useRef(false)
  const toggleOpenMicMute = useCallback(() => {
    const mic = openMicRef.current
    if (!mic || !mic.running) return
    mutedRef.current = !mutedRef.current
    mic.suspend(mutedRef.current || ttsSpeakingRef.current)
  }, [])
  const toggleOpenMicMuteRef = useRef(toggleOpenMicMute)
  toggleOpenMicMuteRef.current = toggleOpenMicMute

  // Start/stop the OpenMic capture pipeline as micMode toggles into/out of 'open'.
  useEffect(() => {
    if (micMode !== 'open') return
    if (voice === null || !voice.stt.available) return
    let cancelled = false

    const run = async (): Promise<void> => {
      setVoiceError(null)
      const granted = await ensureMicAccess()
      if (!granted || cancelled) return
      try {
        await getOpenMic().start({
          onSegment: handleOpenMicSegment,
          onState: handleOpenMicState
        })
        if (cancelled) {
          getOpenMic().stop()
          return
        }
        // Sync initial suspend state in case TTS is already speaking.
        mutedRef.current = false
        getOpenMic().suspend(ttsSpeakingRef.current)
      } catch (err) {
        if (!cancelled) {
          setVoiceError(err instanceof Error ? err.message : 'Could not start hands-free mode')
        }
      }
    }
    void run()

    return () => {
      cancelled = true
      getOpenMic().stop()
      segmentQueueRef.current = []
      queueBusyRef.current = false
      setOpenMicState('listening')
      setOpenMicTranscribing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micMode, voice, ensureMicAccess, handleOpenMicSegment, handleOpenMicState])

  // Suspend/resume hands-free capture while the tutor's TTS is speaking, so we
  // don't transcribe its own voice. A user-initiated mute always keeps it suspended.
  useEffect(() => {
    openMicRef.current?.suspend(mutedRef.current || ttsSpeaking)
  }, [ttsSpeaking])

  // Full teardown on unmount.
  useEffect(() => {
    return () => {
      openMicRef.current?.stop()
    }
  }, [])

  // ---------- Hotkey: ⌥Space (Alt+Space) ----------
  // Manual mode: tap to toggle recording on/off, or hold to push-to-talk.
  // Hands-free mode: toggles mute (suspend) on/off.

  useEffect(() => {
    if (voice === null || !voice.stt.available) return

    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.code !== 'Space') return
      event.preventDefault()
      if (event.repeat) return

      if (micModeRef.current === 'open') {
        toggleOpenMicMuteRef.current()
        return
      }

      if (voiceStateRef.current === 'idle') {
        spacePressStartRef.current = Date.now()
        void startRecordingRef.current()
      } else if (voiceStateRef.current === 'recording') {
        void stopRecordingRef.current()
      }
    }

    const handleWindowKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      if (micModeRef.current !== 'manual') return
      if (voiceStateRef.current !== 'recording') return
      const pressedAt = spacePressStartRef.current
      if (pressedAt === null) return
      const heldMs = Date.now() - pressedAt
      spacePressStartRef.current = null
      if (heldMs >= HOLD_THRESHOLD_MS) {
        void stopRecordingRef.current()
      }
      // A quick tap (<300ms) leaves recording running until the next tap.
    }

    window.addEventListener('keydown', handleWindowKeyDown, true)
    window.addEventListener('keyup', handleWindowKeyUp, true)
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true)
      window.removeEventListener('keyup', handleWindowKeyUp, true)
    }
  }, [voice])

  const handleMicClick = useCallback(() => {
    if (micMode === 'open') {
      onMicModeChange('manual')
      return
    }
    if (voiceState === 'recording') {
      void stopRecordingAndTranscribe()
    } else if (voiceState === 'idle') {
      void startRecording()
    }
  }, [micMode, onMicModeChange, voiceState, startRecording, stopRecordingAndTranscribe])

  // Escape cancels an in-progress manual recording.
  useEffect(() => {
    if (voiceState !== 'recording') return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        getRecorder().cancel()
        setVoiceState('idle')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [voiceState])

  // Cancel any in-flight recording if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      if (recorderRef.current?.recording) {
        recorderRef.current.cancel()
      }
    }
  }, [])

  const micDisabled = voice === null || !voice.stt.available
  const handsFreeAvailable = voice !== null && voice.stt.available

  let micTitle: string | undefined
  if (voice !== null && !voice.stt.available) {
    micTitle = voice.stt.reason
  } else if (micMode === 'open') {
    micTitle =
      openMicState === 'suspended'
        ? 'Paused while the tutor speaks'
        : 'Hands-free on — click to switch to manual'
  } else {
    micTitle = 'Voice input (⌥Space: tap to toggle, hold to talk)'
  }

  let placeholder = 'Ask your instructor…'
  if (micMode === 'open') {
    if (openMicTranscribing) {
      placeholder = 'Transcribing…'
    } else if (openMicState === 'speech') {
      placeholder = 'Listening…'
    } else if (openMicState === 'suspended') {
      placeholder = 'Hands-free paused while the tutor speaks'
    } else {
      placeholder = 'Hands-free — just start talking'
    }
  } else if (voiceState === 'recording') {
    placeholder = 'Listening — click to stop · Esc to cancel'
  } else if (voiceState === 'transcribing') {
    placeholder = 'Transcribing…'
  }

  const controlsDisabled = voiceState === 'transcribing'

  let micLabel = '🎤'
  let micClass = 'mic-btn'
  if (micMode === 'open') {
    if (openMicTranscribing) {
      micLabel = '⏳'
      micClass = 'mic-btn mic-btn-transcribing'
    } else if (openMicState === 'speech') {
      micLabel = '🎙'
      micClass = 'mic-btn mic-btn-recording'
    } else if (openMicState === 'suspended') {
      micLabel = '💤'
      micClass = 'mic-btn mic-btn-suspended'
    } else {
      micLabel = '🎙'
      micClass = 'mic-btn mic-btn-live'
    }
  } else if (voiceState === 'recording') {
    micLabel = '⏹'
    micClass = 'mic-btn mic-btn-recording'
  } else if (voiceState === 'transcribing') {
    micLabel = '⏳'
    micClass = 'mic-btn mic-btn-transcribing'
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        {voice !== null && (
          <button
            type="button"
            className={micClass}
            onClick={handleMicClick}
            disabled={micDisabled || (micMode === 'manual' && controlsDisabled)}
            title={micTitle}
            aria-label={
              micMode === 'open'
                ? 'Hands-free voice input — click to switch to manual'
                : voiceState === 'recording'
                  ? 'Stop recording'
                  : 'Start voice input'
            }
          >
            {micLabel}
          </button>
        )}
        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={placeholder}
          rows={1}
          value={text}
          disabled={controlsDisabled}
          onChange={(event) => {
            setText(event.target.value)
            autoGrow()
            onStudentActivity()
          }}
          onKeyDown={handleKeyDown}
        />
        {streaming ? (
          <button type="button" className="composer-btn composer-btn-stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="composer-btn composer-btn-send"
            onClick={send}
            disabled={text.trim() === '' || controlsDisabled}
          >
            Send
          </button>
        )}
      </div>
      <div className="composer-row-footer">
        {voice?.tts.available === true && (
          <button
            type="button"
            className={`voice-toggle${voiceReplies ? ' voice-toggle-on' : ''}`}
            onClick={() => onVoiceRepliesChange(!voiceReplies)}
            aria-pressed={voiceReplies}
          >
            <span className="voice-toggle-switch" />
            🔊 Voice replies
          </button>
        )}
        {handsFreeAvailable && (
          <button
            type="button"
            className={`voice-toggle${micMode === 'open' ? ' voice-toggle-on' : ''}`}
            onClick={() => onMicModeChange(micMode === 'open' ? 'manual' : 'open')}
            aria-pressed={micMode === 'open'}
          >
            <span className="voice-toggle-switch" />
            🎙 Hands-free
          </button>
        )}
        {hint !== null && <span className="composer-hint">{hint}</span>}
        {voiceError !== null && <span className="composer-error">{voiceError}</span>}
      </div>
    </div>
  )
}
