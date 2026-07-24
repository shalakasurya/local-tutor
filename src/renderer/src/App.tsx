import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChangedFile,
  Exercise,
  Interview,
  Project,
  Session,
  TranscriptTurn,
  VoiceStatus
} from '../../shared/types'
import SessionSidebar from './components/SessionSidebar'
import TranscriptPane from './components/TranscriptPane'
import Composer from './components/Composer'
import StudyPanel, { type StudyTab, type WhiteboardState } from './components/StudyPanel'
import ScaffoldModal from './components/ScaffoldModal'
import { TtsPlayer } from './lib/ttsPlayer'

/** Payload for a pending scaffold-request approval modal. */
interface ScaffoldRequestState {
  requestId: string
  summary: string
  files: Array<{ path: string; content: string }>
}

function sortByUpdatedDesc(sessions: Session[]): Session[] {
  return [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
}

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<TranscriptTurn[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [activity, setActivity] = useState<string | null>(null)
  const [whiteboards, setWhiteboards] = useState<WhiteboardState[]>([])
  const [whiteboardIndex, setWhiteboardIndex] = useState(0)
  const [exercises, setExercises] = useState<Exercise[]>([])
  const [exerciseIndex, setExerciseIndex] = useState(0)
  const [tab, setTab] = useState<StudyTab>('whiteboard')
  const [interviews, setInterviews] = useState<Interview[]>([])
  const [selectedInterviewId, setSelectedInterviewId] = useState<string | null>(null)
  const [interviewActive, setInterviewActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [voice, setVoice] = useState<VoiceStatus | null>(null)
  const [voiceReplies, setVoiceRepliesState] = useState<boolean>(() => {
    const stored = localStorage.getItem('voiceReplies')
    return stored === null ? true : stored === '1'
  })
  const [micMode, setMicModeState] = useState<'manual' | 'open'>(() => {
    const stored = localStorage.getItem('micMode')
    return stored === 'open' ? 'open' : 'manual'
  })
  const [ttsSpeaking, setTtsSpeaking] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [sessionProject, setSessionProject] = useState<{
    project: Project
    changes: ChangedFile[]
  } | null>(null)
  const [scaffoldRequest, setScaffoldRequest] = useState<ScaffoldRequestState | null>(null)

  // The event listener is subscribed once; it reads the active session id from a ref.
  const activeSessionIdRef = useRef<string | null>(null)
  // The event listener's closure is fixed at mount time, so it reads/writes whiteboard
  // history through this ref (kept in sync with state) rather than the stale state value.
  const whiteboardsRef = useRef<WhiteboardState[]>([])
  // Same pattern as whiteboardsRef, for the exercise history.
  const exercisesRef = useRef<Exercise[]>([])
  // Same pattern as whiteboardsRef — the event listener's closure needs the current
  // linked project (and its changes) to match 'project-changes' events against.
  const sessionProjectRef = useRef<{ project: Project; changes: ChangedFile[] } | null>(null)
  // Locally-appended turns get negative ids so they never collide with DB row ids.
  const localIdRef = useRef(-1)
  // Lazily-created WebAudio player for main-synthesized TTS utterances (see 'tts-audio' below).
  const ttsPlayerRef = useRef<TtsPlayer | null>(null)
  if (ttsPlayerRef.current === null) {
    ttsPlayerRef.current = new TtsPlayer()
  }

  // Interview idle-nudge scheduler bookkeeping. lastActivityRef is the timestamp of the
  // most recent student activity (or of a baseline reset — see below); nudgeCountRef caps
  // repeated nudges per idle stretch at 2. Both are refs (not state) since they're only
  // read/written from an interval tick and event handlers, never rendered.
  const lastActivityRef = useRef<number>(Date.now())
  const nudgeCountRef = useRef(0)
  // Fresh-value refs so the scheduler's setInterval callback (subscribed once per
  // interviewActive toggle) always sees current streaming/tts state without re-subscribing.
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  const ttsSpeakingRef = useRef(ttsSpeaking)
  ttsSpeakingRef.current = ttsSpeaking

  const nextLocalId = (): number => localIdRef.current--

  // A real student answer resets everything — both the idle clock and the nudge count.
  const markStudentActivity = useCallback(() => {
    lastActivityRef.current = Date.now()
    nudgeCountRef.current = 0
  }, [])

  const selectSession = useCallback(async (id: string) => {
    void window.tutor.stopSpeaking()
    setActiveSessionId(id)
    activeSessionIdRef.current = id
    setStreaming(false)
    setStreamText('')
    setActivity(null)
    setError(null)
    whiteboardsRef.current = []
    setWhiteboards([])
    setWhiteboardIndex(0)
    exercisesRef.current = []
    setExercises([])
    setExerciseIndex(0)
    sessionProjectRef.current = null
    setSessionProject(null)
    setTab('whiteboard')
    // Switching sessions leaves any in-progress interview behind.
    setInterviewActive(false)
    lastActivityRef.current = Date.now()
    nudgeCountRef.current = 0
    setTurns([])
    try {
      const [transcript, state, projectState] = await Promise.all([
        window.tutor.getTranscript(id),
        window.tutor.getSessionState(id),
        window.tutor.getSessionProjectState(id)
      ])
      // Guard against a session switch racing this load.
      if (activeSessionIdRef.current === id) {
        setTurns(transcript)
        const boards: WhiteboardState[] = state.whiteboards.map((w) => ({
          markdown: w.markdown,
          title: w.title ?? undefined,
          createdAt: w.createdAt
        }))
        whiteboardsRef.current = boards
        setWhiteboards(boards)
        setWhiteboardIndex(boards.length > 0 ? boards.length - 1 : 0)
        exercisesRef.current = state.exercises
        setExercises(state.exercises)
        setExerciseIndex(state.exercises.length > 0 ? state.exercises.length - 1 : 0)
        sessionProjectRef.current = projectState
        setSessionProject(projectState)
        if (state.whiteboards.length === 0 && state.exercises.length > 0) {
          setTab('exercise')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transcript')
    }
  }, [])

  // Initial load: list sessions, create one if none exist, select the most recent.
  // The ref guard keeps StrictMode's double-mounted effect from creating two sessions.
  // Note: no cancellation on cleanup — App is the root component and never truly
  // unmounts; StrictMode's mount→unmount→remount keeps the same state, and the
  // guarded first run must be allowed to finish (a cancel flag here left the
  // sidebar permanently empty because the second run bails on the guard).
  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    const init = async (): Promise<void> => {
      try {
        let list = await window.tutor.listSessions()
        if (list.length === 0) {
          const created = await window.tutor.createSession()
          list = [created]
        }
        const sorted = sortByUpdatedDesc(list)
        console.log(`[app] loaded ${sorted.length} session(s)`)
        setSessions(sorted)
        const mostRecent = sorted[0]
        if (mostRecent) {
          void selectSession(mostRecent.id)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load sessions')
      }
    }
    void init()
  }, [selectSession])

  // Subscribe once to tutor events pushed from the main process.
  useEffect(() => {
    const unsubscribe = window.tutor.onEvent((event) => {
      // 'speaking' is global (TTS started/stopped) — must be handled before
      // the session-id filter below, which only applies to session-scoped events.
      if (event.type === 'speaking') {
        setTtsSpeaking(event.active)
        return
      }

      // 'tts-audio' / 'tts-stop' are global (renderer-side WebAudio playback of
      // main-synthesized TTS, so Chrome's echo canceller can see the reference
      // signal) — handle before the session filter, same as 'speaking'.
      if (event.type === 'tts-audio') {
        const player = ttsPlayerRef.current
        if (player) {
          void player.play(event.utteranceId, event.wav, (id) =>
            void window.tutor.ttsPlaybackEnded(id).catch(() => {})
          )
        }
        return
      }
      if (event.type === 'tts-stop') {
        ttsPlayerRef.current?.stop()
        return
      }

      // 'project-changes' is a global watcher feed (sessionId is '' when no session
      // is linked) — match it against the currently-linked project instead of the
      // active session, and handle it before the session filter below.
      if (event.type === 'project-changes') {
        if (sessionProjectRef.current !== null && sessionProjectRef.current.project.id === event.projectId) {
          const next = { project: sessionProjectRef.current.project, changes: event.files }
          sessionProjectRef.current = next
          setSessionProject(next)
        }
        return
      }

      // 'scaffold-request' must never be missed even if it arrives for a session
      // that isn't currently active, so it's handled before the session filter too.
      if (event.type === 'scaffold-request') {
        setScaffoldRequest({
          requestId: event.requestId,
          summary: event.summary,
          files: event.files
        })
        return
      }

      if (event.sessionId !== activeSessionIdRef.current) return

      switch (event.type) {
        case 'turn-start':
          setStreaming(true)
          setStreamText('')
          break
        case 'delta':
          setStreamText((prev) => prev + event.text)
          break
        case 'turn-end':
          if (event.fullText.trim() !== '') {
            setTurns((prev) => [
              ...prev,
              {
                id: nextLocalId(),
                sessionId: event.sessionId,
                role: 'instructor',
                content: event.fullText,
                createdAt: new Date().toISOString()
              }
            ])
          }
          setStreaming(false)
          setStreamText('')
          setActivity(null)
          // The question just finished being asked — restart the idle clock, but
          // don't reset the nudge count (repeated nudges must still cap at 2).
          lastActivityRef.current = Date.now()
          // Titles/timestamps may have changed (first message names the session).
          void window.tutor
            .listSessions()
            .then((list) => setSessions(sortByUpdatedDesc(list)))
            .catch(() => {})
          break
        case 'tool-activity':
          setActivity(event.summary)
          break
        case 'whiteboard': {
          const next = [
            ...whiteboardsRef.current,
            {
              markdown: event.markdown,
              title: event.title,
              createdAt: new Date().toISOString()
            }
          ]
          whiteboardsRef.current = next
          setWhiteboards(next)
          setWhiteboardIndex(next.length - 1)
          setTab('whiteboard')
          break
        }
        case 'exercise': {
          const next = [...exercisesRef.current, event.exercise]
          exercisesRef.current = next
          setExercises(next)
          setExerciseIndex(next.length - 1)
          setTab('exercise')
          break
        }
        case 'error':
          setError(event.message)
          setStreaming(false)
          setStreamText('')
          setActivity(null)
          break
        case 'interview-started':
          setInterviewActive(true)
          lastActivityRef.current = Date.now()
          nudgeCountRef.current = 0
          break
        case 'interview-completed':
          setInterviewActive(false)
          setInterviews((prev) => [event.interview, ...prev])
          setSelectedInterviewId(event.interview.id)
          setTab('interviews')
          break
        case 'project-linked': {
          const next = { project: event.project, changes: [] }
          sessionProjectRef.current = next
          setSessionProject(next)
          void window.tutor
            .listProjects()
            .then((list) => setProjects(list))
            .catch(() => {})
          setTab('projects')
          break
        }
      }
    })
    return unsubscribe
  }, [])

  // Load completed mock-interview reports once on mount.
  useEffect(() => {
    let cancelled = false
    window.tutor
      .listInterviews()
      .then((list) => {
        if (!cancelled) setInterviews(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Load known projects once on mount.
  useEffect(() => {
    let cancelled = false
    window.tutor
      .listProjects()
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Clicking a transcript turn navigates the whiteboard (and exercise) history to
  // what was current at that point in the conversation: the latest snapshot created
  // at or before the turn's timestamp (an instructor turn's timestamp is its end, so
  // boards/exercises created during that reply are included). Whiteboard takes
  // priority for the tab switch when both have a match, matching current behavior.
  const handleTurnClick = useCallback(
    (turn: TranscriptTurn) => {
      const turnAt = Date.parse(turn.createdAt)
      if (Number.isNaN(turnAt)) return
      let whiteboardTarget = -1
      for (let i = 0; i < whiteboards.length; i++) {
        const at = whiteboards[i].createdAt ? Date.parse(whiteboards[i].createdAt as string) : NaN
        if (!Number.isNaN(at) && at <= turnAt) whiteboardTarget = i
      }
      let exerciseTarget = -1
      for (let i = 0; i < exercises.length; i++) {
        const at = Date.parse(exercises[i].createdAt)
        if (!Number.isNaN(at) && at <= turnAt) exerciseTarget = i
      }
      if (whiteboardTarget >= 0) {
        setWhiteboardIndex(whiteboardTarget)
      }
      if (exerciseTarget >= 0) {
        setExerciseIndex(exerciseTarget)
      }
      if (whiteboardTarget >= 0) {
        setTab('whiteboard')
      } else if (exerciseTarget >= 0) {
        setTab('exercise')
      }
    },
    [whiteboards, exercises]
  )

  const handleNewSession = useCallback(async () => {
    try {
      const created = await window.tutor.createSession()
      setSessions((prev) => [created, ...prev])
      void selectSession(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    }
  }, [selectSession])

  // Optimistically renames in local state, then persists; reverts via the error banner on failure.
  const handleRenameSession = useCallback((id: string, title: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    window.tutor.renameSession(id, title).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to rename session')
    })
  }, [])

  // Deletes a session; if it was active, falls back to the next-most-recent remaining
  // session, or creates a fresh one (same logic as handleNewSession) if none remain.
  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await window.tutor.deleteSession(id)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete session')
        return
      }
      const remaining = sessions.filter((s) => s.id !== id)
      setSessions(remaining)
      if (activeSessionIdRef.current === id) {
        const next = sortByUpdatedDesc(remaining)[0]
        if (next) {
          void selectSession(next.id)
        } else {
          void handleNewSession()
        }
      }
    },
    [sessions, selectSession, handleNewSession]
  )

  // Shared by the composer and the exercise REPL's "Submit for review" action: appends an
  // optimistic student turn, then forwards the message to the instructor.
  const sendStudentMessage = useCallback(
    (text: string) => {
      const sessionId = activeSessionIdRef.current
      if (!sessionId) return
      markStudentActivity()
      setError(null)
      setTurns((prev) => [
        ...prev,
        {
          id: nextLocalId(),
          sessionId,
          role: 'student',
          content: text,
          createdAt: new Date().toISOString()
        }
      ])
      window.tutor.sendMessage(sessionId, text).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to send message')
      })
    },
    [markStudentActivity]
  )

  const handleSend = sendStudentMessage

  // Keeps App's copy of the exercise history in sync with autosaves made inside
  // ReplPane, so navigating away and back (or switching sessions and returning)
  // shows the latest saved code instead of the stale snapshot from load time.
  const handleExerciseCodeSaved = useCallback((exerciseId: string, code: string) => {
    const next = exercisesRef.current.map((ex) =>
      ex.id === exerciseId ? { ...ex, solutionCode: code } : ex
    )
    exercisesRef.current = next
    setExercises(next)
  }, [])

  // Opens the native folder picker (via main) and attaches the chosen directory as a
  // project linked to the active session. Refreshes both the project list and the
  // active-session project state on success; null means the picker was cancelled.
  const handleAttachProject = useCallback(async () => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    try {
      const p = await window.tutor.attachProject(sessionId)
      if (p) {
        const [list, projectState] = await Promise.all([
          window.tutor.listProjects(),
          window.tutor.getSessionProjectState(sessionId)
        ])
        setProjects(list)
        sessionProjectRef.current = projectState
        setSessionProject(projectState)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to attach project')
    }
  }, [])

  // Switch the session's active project to an already-registered one (Projects list click).
  // The resulting 'project-linked' event updates sessionProject/tab; we refresh changes here.
  const handleSelectProject = useCallback(async (projectId: string) => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    try {
      const p = await window.tutor.linkProject(sessionId, projectId)
      if (p) {
        const projectState = await window.tutor.getSessionProjectState(sessionId)
        sessionProjectRef.current = projectState
        setSessionProject(projectState)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch project')
    }
  }, [])

  // Optimistically flips the push mode in both the projects list and the active
  // session's project (if it's the same project), then persists via the bridge.
  const handlePushModeChange = useCallback(
    (projectId: string, mode: Project['pushMode']) => {
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, pushMode: mode } : p)))
      if (sessionProjectRef.current !== null && sessionProjectRef.current.project.id === projectId) {
        const next = {
          project: { ...sessionProjectRef.current.project, pushMode: mode },
          changes: sessionProjectRef.current.changes
        }
        sessionProjectRef.current = next
        setSessionProject(next)
      }
      window.tutor.setProjectPushMode(projectId, mode).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to update push mode')
      })
    },
    []
  )

  const handleOpenProject = useCallback((projectId: string, target: 'editor' | 'finder') => {
    window.tutor.openProject(projectId, target).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to open project')
    })
  }, [])

  const handleScaffoldRespond = useCallback((requestId: string, approved: boolean) => {
    setScaffoldRequest(null)
    window.tutor.respondScaffold(requestId, approved).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to respond to scaffold request')
    })
  }, [])

  const handleStop = useCallback(() => {
    void window.tutor.stopSpeaking()
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    window.tutor.interrupt(sessionId).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to interrupt')
    })
  }, [])

  // Baseline reset (no nudge-count reset) when the tutor stops speaking — the
  // question has just finished being spoken, so the idle clock restarts.
  const prevTtsSpeakingRef = useRef(ttsSpeaking)
  useEffect(() => {
    if (prevTtsSpeakingRef.current && !ttsSpeaking) {
      lastActivityRef.current = Date.now()
    }
    prevTtsSpeakingRef.current = ttsSpeaking
  }, [ttsSpeaking])

  // Interview idle-nudge scheduler: while an interview is active, poll every 5s for
  // ~25s of student inactivity and ask the main process to have the interviewer speak
  // a check-in — about as long as a human coach lets silence sit in conversation.
  // Capped at 3 nudges per idle stretch (reset by markStudentActivity).
  useEffect(() => {
    if (!interviewActive) return
    const interval = setInterval(() => {
      if (streamingRef.current || ttsSpeakingRef.current) return
      if (activeSessionIdRef.current === null) return
      const idle = Date.now() - lastActivityRef.current
      if (idle >= 25_000 && nudgeCountRef.current < 3) {
        nudgeCountRef.current += 1
        lastActivityRef.current = Date.now()
        window.tutor
          .sendInterviewNudge(activeSessionIdRef.current, Math.round(idle / 1000), nudgeCountRef.current)
          .catch(() => {})
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [interviewActive])

  // Load voice (STT/TTS) availability once on mount.
  useEffect(() => {
    let cancelled = false
    window.tutor
      .voiceStatus()
      .then((status) => {
        if (!cancelled) setVoice(status)
      })
      .catch(() => {
        if (!cancelled) setVoice({ stt: { available: false }, tts: { available: false } })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Persist the voice-replies preference and push it to main whenever it changes,
  // and once more after voiceStatus resolves (to gate on actual TTS availability).
  useEffect(() => {
    localStorage.setItem('voiceReplies', voiceReplies ? '1' : '0')
    const ttsAvailable = voice?.tts.available ?? false
    window.tutor.setVoiceReplies(voiceReplies && ttsAvailable).catch(() => {})
  }, [voiceReplies, voice])

  // Persist the hands-free mic mode preference.
  useEffect(() => {
    localStorage.setItem('micMode', micMode)
  }, [micMode])

  return (
    <div className="app">
      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={(id) => void selectSession(id)}
        onNewSession={() => void handleNewSession()}
        onDelete={(id) => void handleDeleteSession(id)}
        onRename={handleRenameSession}
      />

      <main className="classroom">
        {error !== null && (
          <div className="error-banner" role="alert">
            <span className="error-banner-text">{error}</span>
            <button
              type="button"
              className="error-banner-dismiss"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        <TranscriptPane
          turns={turns}
          streaming={streaming}
          streamText={streamText}
          activity={activity}
          onTurnClick={handleTurnClick}
          onReplay={
            voice?.tts.available === true ? (text) => void window.tutor.speakText(text) : null
          }
        />

        <Composer
          streaming={streaming}
          onSend={handleSend}
          onStop={handleStop}
          voice={voice}
          voiceReplies={voiceReplies}
          onVoiceRepliesChange={setVoiceRepliesState}
          onStopSpeaking={() => void window.tutor.stopSpeaking()}
          micMode={micMode}
          onMicModeChange={setMicModeState}
          ttsSpeaking={ttsSpeaking}
          onStudentActivity={markStudentActivity}
        />
      </main>

      <StudyPanel
        tab={tab}
        onTabChange={setTab}
        whiteboards={whiteboards}
        whiteboardIndex={whiteboardIndex}
        onWhiteboardIndexChange={setWhiteboardIndex}
        exercises={exercises}
        exerciseIndex={exerciseIndex}
        onExerciseIndexChange={setExerciseIndex}
        onCodeSaved={handleExerciseCodeSaved}
        sessionId={activeSessionId}
        onStudentMessage={sendStudentMessage}
        interviews={interviews}
        selectedInterviewId={selectedInterviewId}
        onSelectInterview={setSelectedInterviewId}
        interviewActive={interviewActive}
        onStudentActivity={markStudentActivity}
        projects={projects}
        sessionProject={sessionProject}
        onAttachProject={() => void handleAttachProject()}
        onSelectProject={(id) => void handleSelectProject(id)}
        onProjectPushModeChange={handlePushModeChange}
        onOpenProject={handleOpenProject}
      />

      {scaffoldRequest !== null && (
        <ScaffoldModal request={scaffoldRequest} onRespond={handleScaffoldRespond} />
      )}
    </div>
  )
}
