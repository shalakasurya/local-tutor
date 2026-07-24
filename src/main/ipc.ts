import { ipcMain, systemPreferences } from 'electron'
import { IPC } from '../shared/types'
import type { DbApi, ExerciseTest, LastRun, Project } from '../shared/types'
import type { Instructor } from './instructor'
import type { ProjectsService } from './projects'
import { runCode, runTests } from './runner'
import { sttStatus, transcribe } from './stt'
import type { Speaker } from './tts'

export function registerIpc(
  db: DbApi,
  instructor: Instructor,
  runStore: Map<string, LastRun>,
  speaker: Speaker,
  projects: ProjectsService
): void {
  ipcMain.handle(IPC.send, (_event, sessionId: string, text: string) => {
    // Fire and forget — progress streams back to the renderer as TutorEvents.
    instructor.handleStudentMessage(sessionId, text).catch((err) => console.error(err))
  })

  ipcMain.handle(IPC.interrupt, (_event, sessionId: string) => {
    instructor.interrupt(sessionId)
  })

  ipcMain.handle(IPC.createSession, (_event, title?: string) => {
    return db.createSession(title ?? 'New session')
  })

  ipcMain.handle(IPC.listSessions, () => db.listSessions())

  ipcMain.handle(IPC.getTranscript, (_event, sessionId: string) => db.getTranscript(sessionId))

  ipcMain.handle(IPC.listLessons, () => db.listLessons())

  ipcMain.handle(IPC.listExercises, () => db.listExercises())

  ipcMain.handle(IPC.listProgress, () => db.listProgress())

  ipcMain.handle(IPC.listInterviews, () => db.listInterviews())

  ipcMain.handle(IPC.listProjects, () => db.listProjects())

  ipcMain.handle(IPC.attachProject, (_event, sessionId: string) =>
    projects.attachViaPicker(sessionId)
  )

  ipcMain.handle(IPC.linkProject, (_event, sessionId: string, projectId: string) =>
    projects.linkToSession(sessionId, projectId)
  )

  ipcMain.handle(IPC.sessionProjectState, async (_event, sessionId: string) => {
    const project = db.getSessionProject(sessionId)
    if (!project) return null
    return { project, changes: await projects.currentChanges(project) }
  })

  ipcMain.handle(IPC.projectPushMode, (_event, projectId: string, mode: Project['pushMode']) => {
    db.setProjectPushMode(projectId, mode)
  })

  ipcMain.handle(IPC.respondScaffold, (_event, requestId: string, approved: boolean) => {
    projects.respondScaffold(requestId, approved)
  })

  ipcMain.handle(IPC.openProject, (_event, projectId: string, target: 'editor' | 'finder') => {
    const project = db.getProject(projectId)
    if (project) projects.openIn(project, target)
  })

  ipcMain.handle(
    IPC.interviewNudge,
    (_event, sessionId: string, idleSeconds: number, nudgeNumber: number) => {
      // Only meaningful while an interview is actually running — guard here so a
      // stale renderer timer can never make the tutor check in outside interviews.
      if (!db.getActiveInterview(sessionId)) return
      const escalation =
        nudgeNumber >= 2
          ? ' — they still seem stuck, so offer a concrete hint or the option to move on to the next question'
          : ' — for example, invite them to think aloud or ask whether the question needs clarifying'
      const note =
        `The candidate has been silent for about ${Math.round(idleSeconds)} seconds on the current ` +
        `interview question (check-in #${nudgeNumber}). Check in briefly and naturally, out loud, as a ` +
        `human interviewer would${escalation}. One or two spoken sentences; do not repeat the full ` +
        `question; do not mention the elapsed time, this reminder, or that you were prompted.`
      instructor.handleStudentMessage(sessionId, note, { hidden: true }).catch((err) => {
        console.error(err)
      })
    }
  )

  ipcMain.handle(IPC.deleteSession, (_event, sessionId: string) => {
    instructor.forgetSession(sessionId)
    runStore.delete(sessionId)
    db.deleteSession(sessionId)
  })

  ipcMain.handle(IPC.renameSession, (_event, sessionId: string, title: string) => {
    const trimmed = String(title).replace(/\s+/g, ' ').trim().slice(0, 80)
    if (trimmed) db.updateSessionTitle(sessionId, trimmed)
  })

  ipcMain.handle(IPC.sessionState, (_event, sessionId: string) => ({
    whiteboards: db.listWhiteboards(sessionId),
    exercises: db.listSessionExercises(sessionId)
  }))

  ipcMain.handle(IPC.runCode, (_event, input: { language: string; code: string }) => {
    return runCode(input)
  })

  ipcMain.handle(
    IPC.runTests,
    (_event, input: { language: string; code: string; tests: ExerciseTest[] }) => runTests(input)
  )

  ipcMain.handle(IPC.saveExerciseCode, (_event, exerciseId: string, code: string) => {
    db.saveExerciseCode(exerciseId, code)
  })

  ipcMain.handle(
    IPC.reportRun,
    (
      _event,
      { sessionId, exerciseId, code, output }: { sessionId: string; exerciseId: string; code: string; output: string }
    ) => {
      runStore.set(sessionId, { exerciseId, code, output, at: new Date().toISOString() })
      db.updateExerciseSolution(exerciseId, code, 'attempted')
    }
  )

  ipcMain.handle(IPC.voiceStatus, () => ({ stt: sttStatus(), tts: speaker.status() }))

  ipcMain.handle(IPC.requestMic, () => {
    if (process.platform === 'darwin') {
      return systemPreferences.askForMediaAccess('microphone')
    }
    return true
  })

  ipcMain.handle(IPC.transcribe, (_event, wav: ArrayBuffer) => transcribe(Buffer.from(wav)))

  ipcMain.handle(IPC.setVoiceReplies, (_event, enabled: boolean) => speaker.setEnabled(enabled))

  ipcMain.handle(IPC.stopSpeaking, () => speaker.stop())

  ipcMain.handle(IPC.speakText, (_event, text: string) => speaker.speakNow(String(text)))
}
