import 'dotenv/config'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/types'
import type { LastRun, TutorEvent } from '../shared/types'
import { createDb } from './db'
import { Instructor } from './instructor'
import { registerIpc } from './ipc'
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

  const emit = (event: TutorEvent): void => {
    sendToRenderer(event)
    speaker.onTutorEvent(event)
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

  registerIpc(db, instructor, runStore, speaker, projects)
  createWindow()

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
