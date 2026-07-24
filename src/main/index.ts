import 'dotenv/config'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/types'
import type { LastRun, TutorEvent } from '../shared/types'
import { createDb } from './db'
import { Instructor } from './instructor'
import { registerIpc } from './ipc'
import { NotesService } from './notes'
import { ProjectsService } from './projects'
import { sttStatus } from './stt'
import { Speaker } from './tts'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  console.log('[voice] stt:', JSON.stringify(sttStatus()))
  const db = createDb(join(app.getPath('userData'), 'local-tutor.db'))
  const runStore = new Map<string, LastRun>()

  const sendToRenderer = (event: TutorEvent): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.event, event)
    }
  }
  // The speaker notifies the renderer of speaking-state changes directly (no feedback loop).
  const speaker = new Speaker(sendToRenderer)

  const notes = new NotesService(db, sendToRenderer)

  const emit = (event: TutorEvent): void => {
    sendToRenderer(event)
    speaker.onTutorEvent(event)
    // Every completed instructor reply feeds the study notebook (debounced).
    if (event.type === 'turn-end') {
      notes.scheduleSync(event.sessionId)
    }
  }
  const instructor = new Instructor(db, emit, (sessionId) => runStore.get(sessionId) ?? null)

  const projects = new ProjectsService(db, join(app.getPath('userData'), 'shadow'), emit, {
    isBusy: (sessionId) => instructor.isBusy(sessionId),
    hasActiveInterview: (sessionId) => db.getActiveInterview(sessionId) !== null,
    injectNote: (sessionId, note) => {
      instructor.handleStudentMessage(sessionId, note, { hidden: true }).catch((err) => {
        console.error(err)
      })
    },
    getWindow: () => win
  })
  instructor.attachProjects(projects)
  projects.startAll()

  registerIpc(db, instructor, runStore, speaker, projects, notes)
  createWindow()

  // ---- Review reminders: the teacher surfaces due flashcards on time ----
  const REVIEW_CHECK_MS = 30 * 60_000
  const REVIEW_THROTTLE_MS = 4 * 3600_000
  const checkReviews = (): void => {
    const due = db.listDueFlashcards(new Date().toISOString())
    sendToRenderer({ type: 'review-due', sessionId: '', dueCount: due.length })
    if (due.length === 0) return
    const last = Number(db.getMeta('last_review_reminder') ?? 0)
    if (Date.now() - last < REVIEW_THROTTLE_MS) return
    const target = db.listSessions()[0]
    if (!target) return
    if (instructor.isBusy(target.id) || db.getActiveInterview(target.id)) return
    db.setMeta('last_review_reminder', String(Date.now()))
    const topics = [...new Set(due.map((c) => c.topic))].slice(0, 5).join(', ')
    instructor
      .handleStudentMessage(
        target.id,
        `The student has ${due.length} flashcard(s) due for review (topics: ${topics}). As their teacher, ` +
          `briefly and warmly offer a quick review session out loud — one or two sentences, no pressure. ` +
          `If they agree, run the review per your flashcard instructions; if they decline or seem ` +
          `mid-task, let it go gracefully. Do not mention this reminder.`,
        { hidden: true }
      )
      .catch((err) => console.error(err))
  }
  setTimeout(checkReviews, 20_000) // shortly after launch, once the window is up
  setInterval(checkReviews, REVIEW_CHECK_MS)

  // One-time conversion of pre-flashcard notes into cards (flagged per session).
  setTimeout(() => {
    notes.backfillCards().catch((err) => console.error('[notes]', err))
  }, 5_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
