// Shared domain types and IPC contract between main, preload, and renderer.
// This file is the single source of truth — main and renderer both import it.

// ---------- Domain ----------

export interface Session {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface TranscriptTurn {
  id: number
  sessionId: string
  role: 'student' | 'instructor'
  content: string
  createdAt: string
}

export interface Lesson {
  id: string
  sessionId: string | null
  title: string
  topics: string[]
  contentMd: string
  status: 'planned' | 'in_progress' | 'completed'
  createdAt: string
}

export interface Exercise {
  id: string
  lessonId: string | null
  sessionId: string | null
  title: string
  promptMd: string
  language: string
  starterCode: string
  solutionCode: string | null
  status: 'assigned' | 'attempted' | 'completed'
  createdAt: string
}

/** A persisted whiteboard render — everything the instructor ever wrote on the board. */
export interface WhiteboardSnapshot {
  id: string
  sessionId: string
  title: string | null
  markdown: string
  createdAt: string
}

// ---------- Projects (external-editor pair programming) ----------

export interface Project {
  id: string
  name: string
  /** Absolute path of the project directory on disk. */
  path: string
  /** 'quiet' = tutor only looks when asked; 'active' = proactive pair-programming comments. */
  pushMode: 'quiet' | 'active'
  createdAt: string
  lastCheckpointAt: string | null
}

export interface ChangedFile {
  path: string
  /** Two-char git porcelain status, e.g. " M", "??", "A " */
  status: string
}

// ---------- Mock interviews ----------

export interface InterviewScore {
  dimension: string
  /** 0–10 */
  score: number
  comment: string
}

export interface Interview {
  id: string
  sessionId: string | null
  kind: string // behavioral | coding | frontend_concepts | system_design
  level: string // junior | mid | senior
  status: 'in_progress' | 'completed' | 'abandoned'
  startedAt: string
  completedAt: string | null
  /** 0–100, null until scored */
  overallScore: number | null
  scores: InterviewScore[]
  reportMd: string | null
}

export interface ProgressNote {
  id: number
  topic: string
  mastery: 'struggling' | 'learning' | 'solid'
  note: string
  createdAt: string
}

// ---------- Code execution (REPL) ----------

/** Result of executing exercise code. */
export type RunResult =
  /** javascript / typescript executed in a Node child process */
  | {
      kind: 'node'
      stdout: string
      stderr: string
      exitCode: number | null
      timedOut: boolean
      durationMs: number
    }
  /** jsx / tsx / html / css bundled into a self-contained HTML document for a sandboxed iframe */
  | { kind: 'web'; html: string }
  /** compile / bundle failure */
  | { kind: 'error'; message: string }

/** The most recent run a student performed in a session (read by the instructor's read_student_code tool). */
export interface LastRun {
  exerciseId: string
  code: string
  output: string
  at: string
}

// ---------- Voice ----------

export interface VoiceStatus {
  /** Speech-to-text via a local whisper.cpp binary (whisper-cli). */
  stt: { available: boolean; reason?: string }
  /** Text-to-speech via the OS speech engine (macOS `say`). */
  tts: { available: boolean; reason?: string }
}

// ---------- Database API (implemented in src/main/db.ts) ----------

export interface DbApi {
  createSession(title: string): Session
  listSessions(): Session[]
  getSession(id: string): Session | null
  touchSession(id: string): void
  updateSessionTitle(id: string, title: string): void
  /** Deletes the session and its turns, raw history, whiteboards, and exercises. Lessons are kept (unlinked). */
  deleteSession(id: string): void

  addTurn(sessionId: string, role: 'student' | 'instructor', content: string): TranscriptTurn
  getTranscript(sessionId: string): TranscriptTurn[]

  /** Raw Anthropic message history (JSON string) for resuming a session's API conversation. */
  getRawMessages(sessionId: string): string | null
  saveRawMessages(sessionId: string, json: string): void

  createLesson(input: {
    sessionId: string | null
    title: string
    topics: string[]
    contentMd: string
  }): Lesson
  listLessons(): Lesson[]

  createExercise(input: {
    lessonId: string | null
    sessionId: string | null
    title: string
    promptMd: string
    language: string
    starterCode: string
  }): Exercise
  listExercises(): Exercise[]
  getExercise(id: string): Exercise | null
  updateExerciseSolution(id: string, code: string, status: Exercise['status']): void
  /** Autosave: persist the editor contents without touching the exercise status. */
  saveExerciseCode(id: string, code: string): void
  /** All exercises for a session, oldest first. */
  listSessionExercises(sessionId: string): Exercise[]

  addWhiteboard(input: {
    sessionId: string
    title: string | null
    markdown: string
  }): WhiteboardSnapshot
  /** All whiteboard snapshots for a session, oldest first. */
  listWhiteboards(sessionId: string): WhiteboardSnapshot[]

  createProject(input: { name: string; path: string }): Project
  listProjects(): Project[]
  getProject(id: string): Project | null
  getProjectByPath(path: string): Project | null
  setProjectPushMode(id: string, mode: Project['pushMode']): void
  touchProjectCheckpoint(id: string, at: string): void
  linkSessionProject(sessionId: string, projectId: string): void
  getSessionProject(sessionId: string): Project | null
  /** Most recently linked session for a project (for watcher events / push comments). */
  getProjectSession(projectId: string): string | null

  createInterview(input: { sessionId: string; kind: string; level: string }): Interview
  /** Latest in-progress interview for a session, if any. */
  getActiveInterview(sessionId: string): Interview | null
  /** Marks any in-progress interviews for the session as abandoned (before starting a new one). */
  abandonActiveInterviews(sessionId: string): void
  completeInterview(
    id: string,
    input: { overallScore: number; scores: InterviewScore[]; reportMd: string }
  ): void
  /** Completed interviews across all sessions, newest first. */
  listInterviews(): Interview[]

  addProgressNote(input: {
    topic: string
    mastery: ProgressNote['mastery']
    note: string
  }): ProgressNote
  listProgress(): ProgressNote[]
}

// ---------- Events pushed from main -> renderer ----------

export type TutorEvent =
  | { type: 'turn-start'; sessionId: string }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'turn-end'; sessionId: string; fullText: string }
  | { type: 'tool-activity'; sessionId: string; toolName: string; summary: string }
  | { type: 'whiteboard'; sessionId: string; markdown: string; title?: string }
  | { type: 'exercise'; sessionId: string; exercise: Exercise }
  | { type: 'error'; sessionId: string; message: string }
  /** TTS started/stopped speaking. Global (not session-scoped) — handle before any session filtering. */
  | { type: 'speaking'; sessionId: string; active: boolean }
  | { type: 'interview-started'; sessionId: string; interview: Interview }
  | { type: 'interview-completed'; sessionId: string; interview: Interview }
  /** A project was created (via tutor tool) or attached (via UI) and linked to the session. */
  | { type: 'project-linked'; sessionId: string; project: Project }
  /** Live watcher feed: files changed on disk since the last checkpoint. Global — sessionId is the linked session ('' if none). */
  | { type: 'project-changes'; sessionId: string; projectId: string; files: ChangedFile[] }
  /** The tutor wants to write files — show the approval modal. Resolved via respondScaffold. */
  | {
      type: 'scaffold-request'
      sessionId: string
      requestId: string
      projectId: string
      summary: string
      files: Array<{ path: string; content: string }>
    }

// ---------- Bridge exposed on window.tutor by the preload script ----------

export interface TutorBridge {
  sendMessage(sessionId: string, text: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  createSession(title?: string): Promise<Session>
  deleteSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  listSessions(): Promise<Session[]>
  getTranscript(sessionId: string): Promise<TranscriptTurn[]>
  /** Full whiteboard + exercise history for a session, for restoring the study panel on session switch. */
  getSessionState(sessionId: string): Promise<{
    whiteboards: WhiteboardSnapshot[]
    exercises: Exercise[]
  }>
  listLessons(): Promise<Lesson[]>
  listExercises(): Promise<Exercise[]>
  listProgress(): Promise<ProgressNote[]>
  /** Completed mock-interview reports across all sessions, newest first. */
  listInterviews(): Promise<Interview[]>
  listProjects(): Promise<Project[]>
  /** Opens the native folder picker and attaches the chosen existing directory as a project linked to the session. Null if cancelled. */
  attachProject(sessionId: string): Promise<Project | null>
  /** Link an existing project to the session (switch the session's active project). */
  linkProject(sessionId: string, projectId: string): Promise<Project | null>
  /** The project linked to a session plus its current uncommitted changes. */
  getSessionProjectState(
    sessionId: string
  ): Promise<{ project: Project; changes: ChangedFile[] } | null>
  setProjectPushMode(projectId: string, mode: Project['pushMode']): Promise<void>
  /** Resolve a pending scaffold-request approval modal. */
  respondScaffold(requestId: string, approved: boolean): Promise<void>
  /** Open the project in the system editor ('editor' tries VS Code, falls back to Finder). */
  openProject(projectId: string, target: 'editor' | 'finder'): Promise<void>
  /**
   * Notify the interviewer that the candidate has been idle (interview mode only).
   * The instructor responds with a natural spoken check-in; nothing is added to the
   * visible transcript as a student message. nudgeNumber: 1 = gentle, 2 = offer hint/move on.
   */
  sendInterviewNudge(sessionId: string, idleSeconds: number, nudgeNumber: number): Promise<void>
  /** Compile/execute exercise code (main process). Stateless — does not persist anything. */
  runCode(input: { language: string; code: string }): Promise<RunResult>
  /** Autosave the editor contents for an exercise (debounced by the caller). */
  saveExerciseCode(exerciseId: string, code: string): Promise<void>
  /** Report a completed run: persists the solution attempt and makes it visible to the instructor. */
  reportRun(input: {
    sessionId: string
    exerciseId: string
    code: string
    output: string
  }): Promise<void>
  /** Availability of local speech-to-text and text-to-speech. */
  voiceStatus(): Promise<VoiceStatus>
  /** Ask the OS for microphone access (macOS prompt). Resolves true if granted. */
  requestMicAccess(): Promise<boolean>
  /** Transcribe a 16kHz mono 16-bit WAV recording. Returns the transcript text. */
  transcribe(wav: ArrayBuffer): Promise<string>
  /** Enable/disable spoken instructor replies (sentence-streamed TTS). */
  setVoiceReplies(enabled: boolean): Promise<void>
  /** Stop any in-progress speech immediately (barge-in). */
  stopSpeaking(): Promise<void>
  /** Subscribe to tutor events. Returns an unsubscribe function. */
  onEvent(listener: (event: TutorEvent) => void): () => void
}

// ---------- IPC channel names ----------

export const IPC = {
  send: 'tutor:send',
  interrupt: 'tutor:interrupt',
  createSession: 'sessions:create',
  deleteSession: 'sessions:delete',
  renameSession: 'sessions:rename',
  listSessions: 'sessions:list',
  getTranscript: 'sessions:transcript',
  sessionState: 'sessions:state',
  listLessons: 'lessons:list',
  listExercises: 'exercises:list',
  listProgress: 'progress:list',
  listInterviews: 'interviews:list',
  interviewNudge: 'interview:nudge',
  listProjects: 'projects:list',
  attachProject: 'projects:attach',
  linkProject: 'projects:link',
  sessionProjectState: 'projects:session-state',
  projectPushMode: 'projects:push-mode',
  respondScaffold: 'projects:respond-scaffold',
  openProject: 'projects:open',
  runCode: 'exercise:run',
  reportRun: 'exercise:report-run',
  saveExerciseCode: 'exercise:save-code',
  voiceStatus: 'voice:status',
  requestMic: 'voice:request-mic',
  transcribe: 'voice:transcribe',
  setVoiceReplies: 'voice:set-replies',
  stopSpeaking: 'voice:stop-speaking',
  /** main -> renderer event channel; payload is a TutorEvent */
  event: 'tutor:event'
} as const
