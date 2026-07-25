import 'dotenv/config'
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage } from 'electron'
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
let tray: Tray | null = null
/** Runs whenever a window becomes ready (launch or reopen) — the teacher greets returning students. */
let windowReadyHook: (() => void) | null = null

function createWindow(onReady?: () => void): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    onReady?.()
    return
  }
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

  // Menu-bar-app behavior: window closed → out of the Dock, alive in the tray.
  win.on('closed', () => {
    win = null
    if (tray) app.dock?.hide()
  })
  app.dock?.show()

  // Give the renderer a beat after load to mount and subscribe to events, then
  // run the explicit callback or the standard window-ready hook (review greet).
  const ready = onReady ?? ((): void => windowReadyHook?.())
  win.webContents.once('did-finish-load', () => setTimeout(ready, 1500))

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

  // ---- Review reminders: the teacher pushes, like a real teacher ----
  // Boot: speak up almost immediately when cards are due (tiny throttle only to
  // survive rapid dev restarts). Recurring: check every 15 min, remind at most
  // hourly. The renderer also gets a review-nudge event to bring the Library
  // deck to the forefront at the moment the tutor speaks.
  const REVIEW_CHECK_MS = 15 * 60_000
  const REVIEW_THROTTLE_MS = 60 * 60_000
  // Only guards automated relaunch loops — any human reopen re-prompts.
  const BOOT_THROTTLE_MS = 15_000
  const NOTIFY_THROTTLE_MS = 2 * 3600_000

  const updateTray = (dueCount: number): void => {
    tray?.setTitle(dueCount > 0 ? ` 🎓 ${dueCount}` : ' 🎓')
    tray?.setToolTip(
      dueCount > 0 ? `Local Tutor — ${dueCount} card(s) due for review` : 'Local Tutor'
    )
  }

  /** Spoken, in-app review push (window must be open). */
  const pushSpokenOffer = (due: ReturnType<typeof db.listDueFlashcards>, boot: boolean): void => {
    const target = db.listSessions()[0]
    if (!target) return
    if (instructor.isBusy(target.id) || db.getActiveInterview(target.id)) return
    db.setMeta('last_review_reminder', String(Date.now()))
    const topics = [...new Set(due.map((c) => c.topic))].slice(0, 5).join(', ')
    const hasRetries = due.some((c) => c.lastGrade === 'again')
    const framing = boot
      ? hasRetries
        ? `The student just reopened the app with an UNFINISHED review — ${due.length} card(s) due, some of them retries they got wrong last time. Greet them and push to pick the review back up right away — a real teacher would not let this slide.`
        : `The student just opened the app and has ${due.length} flashcard(s) due (topics: ${topics}). Greet them briefly and push for the review NOW, before new material — friendly but insistent, the way a good teacher starts class with recap.`
      : `The student has ${due.length} flashcard(s) due for review (topics: ${topics}). Push for a quick review session out loud — friendly but insistent; suggest it will only take a few minutes.`
    instructor
      .handleStudentMessage(
        target.id,
        `${framing} If they agree, run the review per your flashcard instructions. If they explicitly decline, accept it gracefully and move on. Do not mention this reminder.`,
        { hidden: true }
      )
      .catch((err) => console.error(err))
    sendToRenderer({ type: 'review-nudge', sessionId: target.id, dueCount: due.length })
  }

  const checkReviews = (mode: 'boot' | 'interval' | 'forced'): void => {
    const due = db.listDueFlashcards(new Date().toISOString())
    sendToRenderer({ type: 'review-due', sessionId: '', dueCount: due.length })
    updateTray(due.length)
    if (due.length === 0) return

    const windowOpen = win !== null && !win.isDestroyed()
    if (windowOpen) {
      const last = Number(db.getMeta('last_review_reminder') ?? 0)
      const throttle =
        mode === 'forced' ? 0 : mode === 'boot' ? BOOT_THROTTLE_MS : REVIEW_THROTTLE_MS
      if (Date.now() - last < throttle) return
      pushSpokenOffer(due, mode !== 'interval')
      return
    }

    // Window closed, app living in the menu bar: reach the student via a
    // system notification instead of speaking into the void.
    const lastNotify = Number(db.getMeta('last_review_notification') ?? 0)
    if (mode !== 'forced' && Date.now() - lastNotify < NOTIFY_THROTTLE_MS) return
    if (!Notification.isSupported()) return
    db.setMeta('last_review_notification', String(Date.now()))
    const notification = new Notification({
      title: `${due.length} card(s) due for review`,
      body: 'Cil is waiting — a few minutes now beats relearning later.'
    })
    notification.on('click', () => {
      createWindow(() => checkReviews('forced'))
    })
    notification.show()
  }

  // Menu-bar residency: the teacher stays on duty after the window closes.
  tray = new Tray(nativeImage.createEmpty())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Local Tutor', click: () => createWindow() },
      { label: 'Review now', click: () => createWindow(() => checkReviews('forced')) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  updateTray(db.listDueFlashcards(new Date().toISOString()).length)

  // Every window appearance (launch, reopen from tray/Dock) greets with the
  // review check — a teacher acknowledges the student walking back in.
  windowReadyHook = () => checkReviews('boot')
  setInterval(() => checkReviews('interval'), REVIEW_CHECK_MS)

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
