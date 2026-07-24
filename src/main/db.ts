import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  DbApi,
  Exercise,
  Flashcard,
  Note,
  Project,
  Interview,
  InterviewScore,
  Lesson,
  ProgressNote,
  Session,
  TranscriptTurn
} from '../shared/types'

interface SessionRow {
  id: string
  title: string
  created_at: string
  updated_at: string
}

interface TurnRow {
  id: number
  session_id: string
  role: 'student' | 'instructor'
  content: string
  created_at: string
}

interface LessonRow {
  id: string
  session_id: string | null
  title: string
  topics: string
  content_md: string
  status: Lesson['status']
  created_at: string
}

interface ExerciseRow {
  id: string
  lesson_id: string | null
  session_id: string | null
  title: string
  prompt_md: string
  language: string
  starter_code: string
  solution_code: string | null
  status: Exercise['status']
  tests: string
  created_at: string
}

interface ProgressRow {
  id: number
  topic: string
  mastery: ProgressNote['mastery']
  note: string
  created_at: string
}

interface FlashcardRow {
  id: string
  topic: string
  front_md: string
  back_md: string
  session_id: string | null
  note_id: string | null
  ease: number
  interval_days: number
  reps: number
  lapses: number
  due_at: string
  last_grade: string | null
  created_at: string
  updated_at: string
}

function toFlashcard(row: FlashcardRow): Flashcard {
  return {
    id: row.id,
    topic: row.topic,
    frontMd: row.front_md,
    backMd: row.back_md,
    sessionId: row.session_id,
    noteId: row.note_id,
    ease: row.ease,
    intervalDays: row.interval_days,
    reps: row.reps,
    lapses: row.lapses,
    dueAt: row.due_at,
    lastGrade: row.last_grade,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

interface NoteRow {
  id: string
  topic: string
  content_md: string
  session_id: string | null
  edited: number
  created_at: string
  updated_at: string
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    topic: row.topic,
    contentMd: row.content_md,
    sessionId: row.session_id,
    edited: row.edited === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

interface ProjectRow {
  id: string
  name: string
  path: string
  push_mode: Project['pushMode']
  created_at: string
  last_checkpoint_at: string | null
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    pushMode: row.push_mode,
    createdAt: row.created_at,
    lastCheckpointAt: row.last_checkpoint_at
  }
}

interface InterviewRow {
  id: string
  session_id: string | null
  kind: string
  level: string
  status: Interview['status']
  started_at: string
  completed_at: string | null
  overall_score: number | null
  scores: string
  report_md: string | null
}

function toInterview(row: InterviewRow): Interview {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    level: row.level,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    overallScore: row.overall_score,
    scores: JSON.parse(row.scores) as InterviewScore[],
    reportMd: row.report_md
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toTurn(row: TurnRow): TranscriptTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at
  }
}

function toLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    topics: JSON.parse(row.topics) as string[],
    contentMd: row.content_md,
    status: row.status,
    createdAt: row.created_at
  }
}

function toExercise(row: ExerciseRow): Exercise {
  return {
    id: row.id,
    lessonId: row.lesson_id,
    sessionId: row.session_id,
    title: row.title,
    promptMd: row.prompt_md,
    language: row.language,
    starterCode: row.starter_code,
    solutionCode: row.solution_code,
    status: row.status,
    tests: JSON.parse(row.tests || '[]') as Exercise['tests'],
    createdAt: row.created_at
  }
}

function toProgressNote(row: ProgressRow): ProgressNote {
  return {
    id: row.id,
    topic: row.topic,
    mastery: row.mastery,
    note: row.note,
    createdAt: row.created_at
  }
}

export function createDb(dbPath: string): DbApi {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS raw_messages (
      session_id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      title TEXT NOT NULL,
      topics TEXT NOT NULL,
      content_md TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exercises (
      id TEXT PRIMARY KEY,
      lesson_id TEXT,
      session_id TEXT,
      title TEXT NOT NULL,
      prompt_md TEXT NOT NULL,
      language TEXT NOT NULL,
      starter_code TEXT NOT NULL,
      solution_code TEXT,
      status TEXT NOT NULL,
      tests TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whiteboards (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT,
      markdown TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      push_mode TEXT NOT NULL DEFAULT 'quiet',
      created_at TEXT NOT NULL,
      last_checkpoint_at TEXT
    );
    CREATE TABLE IF NOT EXISTS session_projects (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS interviews (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      kind TEXT NOT NULL,
      level TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      overall_score INTEGER,
      scores TEXT NOT NULL,
      report_md TEXT
    );
    CREATE TABLE IF NOT EXISTS flashcards (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      front_md TEXT NOT NULL,
      back_md TEXT NOT NULL,
      session_id TEXT,
      note_id TEXT,
      ease REAL NOT NULL DEFAULT 2.5,
      interval_days REAL NOT NULL DEFAULT 0,
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      due_at TEXT NOT NULL,
      last_grade TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      content_md TEXT NOT NULL,
      session_id TEXT,
      edited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_watermarks (
      session_id TEXT PRIMARY KEY,
      last_turn_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      mastery TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)

  // Migration: exercises.tests was added after the table shipped.
  const exerciseCols = db.pragma('table_info(exercises)') as Array<{ name: string }>
  if (!exerciseCols.some((c) => c.name === 'tests')) {
    db.exec("ALTER TABLE exercises ADD COLUMN tests TEXT NOT NULL DEFAULT '[]'")
  }

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
  )
  const selectSessions = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
  const selectSession = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const updateSessionTimestamp = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')

  const insertTurn = db.prepare(
    'INSERT INTO turns (session_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  )
  const selectTurns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY id ASC')

  const selectRawMessages = db.prepare('SELECT json FROM raw_messages WHERE session_id = ?')
  const upsertRawMessages = db.prepare(`
    INSERT INTO raw_messages (session_id, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `)

  const insertLesson = db.prepare(`
    INSERT INTO lessons (id, session_id, title, topics, content_md, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const selectLessons = db.prepare('SELECT * FROM lessons ORDER BY created_at DESC')

  const insertExercise = db.prepare(`
    INSERT INTO exercises (id, lesson_id, session_id, title, prompt_md, language, starter_code, solution_code, status, tests, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const selectExercises = db.prepare('SELECT * FROM exercises ORDER BY created_at DESC')
  const selectExercise = db.prepare('SELECT * FROM exercises WHERE id = ?')
  const updateExerciseSolutionStmt = db.prepare(
    'UPDATE exercises SET solution_code = ?, status = ? WHERE id = ?'
  )

  const selectSessionExercises = db.prepare(
    'SELECT * FROM exercises WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
  )

  const insertWhiteboard = db.prepare(
    'INSERT INTO whiteboards (id, session_id, title, markdown, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const selectWhiteboards = db.prepare(
    'SELECT * FROM whiteboards WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
  )

  const insertProject = db.prepare(
    "INSERT INTO projects (id, name, path, push_mode, created_at, last_checkpoint_at) VALUES (?, ?, ?, 'quiet', ?, NULL)"
  )
  const selectProjects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC')
  const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?')
  const selectProjectByPath = db.prepare('SELECT * FROM projects WHERE path = ?')
  const updateProjectPushMode = db.prepare('UPDATE projects SET push_mode = ? WHERE id = ?')
  const updateProjectCheckpoint = db.prepare(
    'UPDATE projects SET last_checkpoint_at = ? WHERE id = ?'
  )
  const upsertSessionProject = db.prepare(`
    INSERT INTO session_projects (session_id, project_id) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id
  `)
  const selectSessionProject = db.prepare(`
    SELECT p.* FROM projects p JOIN session_projects sp ON sp.project_id = p.id
    WHERE sp.session_id = ?
  `)
  const selectProjectSession = db.prepare(
    'SELECT session_id FROM session_projects WHERE project_id = ? ORDER BY rowid DESC LIMIT 1'
  )

  const insertInterview = db.prepare(`
    INSERT INTO interviews (id, session_id, kind, level, status, started_at, completed_at, overall_score, scores, report_md)
    VALUES (?, ?, ?, ?, 'in_progress', ?, NULL, NULL, '[]', NULL)
  `)
  const selectActiveInterview = db.prepare(
    "SELECT * FROM interviews WHERE session_id = ? AND status = 'in_progress' ORDER BY started_at DESC LIMIT 1"
  )
  const abandonInterviews = db.prepare(
    "UPDATE interviews SET status = 'abandoned' WHERE session_id = ? AND status = 'in_progress'"
  )
  const completeInterviewStmt = db.prepare(`
    UPDATE interviews SET status = 'completed', completed_at = ?, overall_score = ?, scores = ?, report_md = ?
    WHERE id = ?
  `)
  const selectInterviews = db.prepare(
    "SELECT * FROM interviews WHERE status = 'completed' ORDER BY completed_at DESC"
  )

  const insertFlashcard = db.prepare(`
    INSERT INTO flashcards (id, topic, front_md, back_md, session_id, note_id, ease, interval_days, reps, lapses, due_at, last_grade, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 2.5, 0, 0, 0, ?, NULL, ?, ?)
  `)
  const selectFlashcards = db.prepare('SELECT * FROM flashcards ORDER BY due_at ASC')
  const selectDueFlashcards = db.prepare('SELECT * FROM flashcards WHERE due_at <= ? ORDER BY due_at ASC')
  const selectFlashcard = db.prepare('SELECT * FROM flashcards WHERE id = ?')
  const updateFlashcardSrsStmt = db.prepare(`
    UPDATE flashcards SET ease = ?, interval_days = ?, reps = ?, lapses = ?, due_at = ?, last_grade = ?, updated_at = ? WHERE id = ?
  `)
  const deleteFlashcardStmt = db.prepare('DELETE FROM flashcards WHERE id = ?')
  const selectMeta = db.prepare('SELECT value FROM app_meta WHERE key = ?')
  const upsertMeta = db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)

  const insertNote = db.prepare(`
    INSERT INTO notes (id, topic, content_md, session_id, edited, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `)
  const selectNotes = db.prepare('SELECT * FROM notes ORDER BY topic COLLATE NOCASE ASC, created_at ASC')
  const selectNoteTopics = db.prepare('SELECT DISTINCT topic FROM notes ORDER BY topic COLLATE NOCASE ASC')
  const updateNoteStmt = db.prepare('UPDATE notes SET content_md = ?, edited = 1, updated_at = ? WHERE id = ?')
  const deleteNoteStmt = db.prepare('DELETE FROM notes WHERE id = ?')
  const selectWatermark = db.prepare('SELECT last_turn_id FROM note_watermarks WHERE session_id = ?')
  const upsertWatermark = db.prepare(`
    INSERT INTO note_watermarks (session_id, last_turn_id) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET last_turn_id = excluded.last_turn_id
  `)

  const insertProgress = db.prepare(
    'INSERT INTO progress (topic, mastery, note, created_at) VALUES (?, ?, ?, ?)'
  )
  const selectProgress = db.prepare('SELECT * FROM progress ORDER BY created_at DESC')

  return {
    createSession(title) {
      const now = new Date().toISOString()
      const session: Session = { id: randomUUID(), title, createdAt: now, updatedAt: now }
      insertSession.run(session.id, session.title, session.createdAt, session.updatedAt)
      return session
    },

    listSessions() {
      return (selectSessions.all() as SessionRow[]).map(toSession)
    },

    getSession(id) {
      const row = selectSession.get(id) as SessionRow | undefined
      return row ? toSession(row) : null
    },

    touchSession(id) {
      updateSessionTimestamp.run(new Date().toISOString(), id)
    },

    updateSessionTitle(id, title) {
      db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(
        title,
        new Date().toISOString(),
        id
      )
    },

    deleteSession(id) {
      db.transaction(() => {
        db.prepare('DELETE FROM turns WHERE session_id = ?').run(id)
        db.prepare('DELETE FROM raw_messages WHERE session_id = ?').run(id)
        db.prepare('DELETE FROM whiteboards WHERE session_id = ?').run(id)
        db.prepare('DELETE FROM exercises WHERE session_id = ?').run(id)
        // Lesson plans are course material, not conversation — keep them, unlinked.
        db.prepare('UPDATE lessons SET session_id = NULL WHERE session_id = ?').run(id)
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      })()
    },

    addTurn(sessionId, role, content) {
      const createdAt = new Date().toISOString()
      const result = insertTurn.run(sessionId, role, content, createdAt)
      return {
        id: Number(result.lastInsertRowid),
        sessionId,
        role,
        content,
        createdAt
      }
    },

    getTranscript(sessionId) {
      return (selectTurns.all(sessionId) as TurnRow[]).map(toTurn)
    },

    getRawMessages(sessionId) {
      const row = selectRawMessages.get(sessionId) as { json: string } | undefined
      return row ? row.json : null
    },

    saveRawMessages(sessionId, json) {
      upsertRawMessages.run(sessionId, json, new Date().toISOString())
    },

    createLesson(input) {
      const lesson: Lesson = {
        id: randomUUID(),
        sessionId: input.sessionId,
        title: input.title,
        topics: input.topics,
        contentMd: input.contentMd,
        status: 'planned',
        createdAt: new Date().toISOString()
      }
      insertLesson.run(
        lesson.id,
        lesson.sessionId,
        lesson.title,
        JSON.stringify(lesson.topics),
        lesson.contentMd,
        lesson.status,
        lesson.createdAt
      )
      return lesson
    },

    listLessons() {
      return (selectLessons.all() as LessonRow[]).map(toLesson)
    },

    createExercise(input) {
      const exercise: Exercise = {
        id: randomUUID(),
        lessonId: input.lessonId,
        sessionId: input.sessionId,
        title: input.title,
        promptMd: input.promptMd,
        language: input.language,
        starterCode: input.starterCode,
        solutionCode: null,
        status: 'assigned',
        tests: input.tests,
        createdAt: new Date().toISOString()
      }
      insertExercise.run(
        exercise.id,
        exercise.lessonId,
        exercise.sessionId,
        exercise.title,
        exercise.promptMd,
        exercise.language,
        exercise.starterCode,
        exercise.solutionCode,
        exercise.status,
        JSON.stringify(exercise.tests),
        exercise.createdAt
      )
      return exercise
    },

    listExercises() {
      return (selectExercises.all() as ExerciseRow[]).map(toExercise)
    },

    getExercise(id) {
      const row = selectExercise.get(id) as ExerciseRow | undefined
      return row ? toExercise(row) : null
    },

    listSessionExercises(sessionId) {
      return (selectSessionExercises.all(sessionId) as ExerciseRow[]).map(toExercise)
    },

    addWhiteboard(input) {
      const snapshot = {
        id: randomUUID(),
        sessionId: input.sessionId,
        title: input.title,
        markdown: input.markdown,
        createdAt: new Date().toISOString()
      }
      insertWhiteboard.run(
        snapshot.id,
        snapshot.sessionId,
        snapshot.title,
        snapshot.markdown,
        snapshot.createdAt
      )
      return snapshot
    },

    listWhiteboards(sessionId) {
      const rows = selectWhiteboards.all(sessionId) as Array<{
        id: string
        session_id: string
        title: string | null
        markdown: string
        created_at: string
      }>
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        title: row.title,
        markdown: row.markdown,
        createdAt: row.created_at
      }))
    },

    saveExerciseCode(id, code) {
      db.prepare('UPDATE exercises SET solution_code = ? WHERE id = ?').run(code, id)
    },

    updateExerciseSolution(id, code, status) {
      updateExerciseSolutionStmt.run(code, status, id)
    },

    createFlashcard(input) {
      const now = new Date().toISOString()
      const card: Flashcard = {
        id: randomUUID(),
        topic: input.topic,
        frontMd: input.frontMd,
        backMd: input.backMd,
        sessionId: input.sessionId,
        noteId: input.noteId,
        ease: 2.5,
        intervalDays: 0,
        reps: 0,
        lapses: 0,
        dueAt: now,
        lastGrade: null,
        createdAt: now,
        updatedAt: now
      }
      insertFlashcard.run(card.id, card.topic, card.frontMd, card.backMd, card.sessionId, card.noteId, now, now, now)
      return card
    },

    listFlashcards() {
      return (selectFlashcards.all() as FlashcardRow[]).map(toFlashcard)
    },

    listDueFlashcards(nowIso) {
      return (selectDueFlashcards.all(nowIso) as FlashcardRow[]).map(toFlashcard)
    },

    updateFlashcardSrs(id, srs) {
      updateFlashcardSrsStmt.run(
        srs.ease,
        srs.intervalDays,
        srs.reps,
        srs.lapses,
        srs.dueAt,
        srs.lastGrade,
        new Date().toISOString(),
        id
      )
    },

    getFlashcard(id) {
      const row = selectFlashcard.get(id) as FlashcardRow | undefined
      return row ? toFlashcard(row) : null
    },

    deleteFlashcard(id) {
      deleteFlashcardStmt.run(id)
    },

    getMeta(key) {
      const row = selectMeta.get(key) as { value: string } | undefined
      return row ? row.value : null
    },

    setMeta(key, value) {
      upsertMeta.run(key, value)
    },

    createNote(input) {
      const now = new Date().toISOString()
      const note: Note = {
        id: randomUUID(),
        topic: input.topic,
        contentMd: input.contentMd,
        sessionId: input.sessionId,
        edited: false,
        createdAt: now,
        updatedAt: now
      }
      insertNote.run(note.id, note.topic, note.contentMd, note.sessionId, now, now)
      return note
    },

    listNotes() {
      return (selectNotes.all() as NoteRow[]).map(toNote)
    },

    listNoteTopics() {
      return (selectNoteTopics.all() as Array<{ topic: string }>).map((r) => r.topic)
    },

    updateNoteContent(id, contentMd) {
      updateNoteStmt.run(contentMd, new Date().toISOString(), id)
    },

    deleteNote(id) {
      deleteNoteStmt.run(id)
    },

    getNoteWatermark(sessionId) {
      const row = selectWatermark.get(sessionId) as { last_turn_id: number } | undefined
      return row ? row.last_turn_id : 0
    },

    setNoteWatermark(sessionId, turnId) {
      upsertWatermark.run(sessionId, turnId)
    },

    createProject(input) {
      const id = randomUUID()
      const createdAt = new Date().toISOString()
      insertProject.run(id, input.name, input.path, createdAt)
      return {
        id,
        name: input.name,
        path: input.path,
        pushMode: 'quiet',
        createdAt,
        lastCheckpointAt: null
      }
    },

    listProjects() {
      return (selectProjects.all() as ProjectRow[]).map(toProject)
    },

    getProject(id) {
      const row = selectProject.get(id) as ProjectRow | undefined
      return row ? toProject(row) : null
    },

    getProjectByPath(path) {
      const row = selectProjectByPath.get(path) as ProjectRow | undefined
      return row ? toProject(row) : null
    },

    setProjectPushMode(id, mode) {
      updateProjectPushMode.run(mode, id)
    },

    touchProjectCheckpoint(id, at) {
      updateProjectCheckpoint.run(at, id)
    },

    linkSessionProject(sessionId, projectId) {
      upsertSessionProject.run(sessionId, projectId)
    },

    getSessionProject(sessionId) {
      const row = selectSessionProject.get(sessionId) as ProjectRow | undefined
      return row ? toProject(row) : null
    },

    getProjectSession(projectId) {
      const row = selectProjectSession.get(projectId) as { session_id: string } | undefined
      return row ? row.session_id : null
    },

    createInterview(input) {
      const id = randomUUID()
      const startedAt = new Date().toISOString()
      insertInterview.run(id, input.sessionId, input.kind, input.level, startedAt)
      return {
        id,
        sessionId: input.sessionId,
        kind: input.kind,
        level: input.level,
        status: 'in_progress',
        startedAt,
        completedAt: null,
        overallScore: null,
        scores: [],
        reportMd: null
      }
    },

    getActiveInterview(sessionId) {
      const row = selectActiveInterview.get(sessionId) as InterviewRow | undefined
      return row ? toInterview(row) : null
    },

    abandonActiveInterviews(sessionId) {
      abandonInterviews.run(sessionId)
    },

    completeInterview(id, input) {
      completeInterviewStmt.run(
        new Date().toISOString(),
        input.overallScore,
        JSON.stringify(input.scores),
        input.reportMd,
        id
      )
    },

    listInterviews() {
      return (selectInterviews.all() as InterviewRow[]).map(toInterview)
    },

    addProgressNote(input) {
      const createdAt = new Date().toISOString()
      const result = insertProgress.run(input.topic, input.mastery, input.note, createdAt)
      return {
        id: Number(result.lastInsertRowid),
        topic: input.topic,
        mastery: input.mastery,
        note: input.note,
        createdAt
      }
    },

    listProgress() {
      return (selectProgress.all() as ProgressRow[]).map(toProgressNote)
    }
  }
}
