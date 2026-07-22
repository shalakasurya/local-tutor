import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '../shared/types'
import type { TutorBridge, TutorEvent } from '../shared/types'

const bridge: TutorBridge = {
  sendMessage: (sessionId, text) => ipcRenderer.invoke(IPC.send, sessionId, text),
  interrupt: (sessionId) => ipcRenderer.invoke(IPC.interrupt, sessionId),
  createSession: (title) => ipcRenderer.invoke(IPC.createSession, title),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getTranscript: (sessionId) => ipcRenderer.invoke(IPC.getTranscript, sessionId),
  listLessons: () => ipcRenderer.invoke(IPC.listLessons),
  listExercises: () => ipcRenderer.invoke(IPC.listExercises),
  listProgress: () => ipcRenderer.invoke(IPC.listProgress),
  listInterviews: () => ipcRenderer.invoke(IPC.listInterviews),
  sendInterviewNudge: (sessionId, idleSeconds, nudgeNumber) =>
    ipcRenderer.invoke(IPC.interviewNudge, sessionId, idleSeconds, nudgeNumber),
  getSessionState: (sessionId) => ipcRenderer.invoke(IPC.sessionState, sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  renameSession: (sessionId, title) => ipcRenderer.invoke(IPC.renameSession, sessionId, title),
  runCode: (input) => ipcRenderer.invoke(IPC.runCode, input),
  reportRun: (input) => ipcRenderer.invoke(IPC.reportRun, input),
  saveExerciseCode: (exerciseId, code) => ipcRenderer.invoke(IPC.saveExerciseCode, exerciseId, code),
  voiceStatus: () => ipcRenderer.invoke(IPC.voiceStatus),
  requestMicAccess: () => ipcRenderer.invoke(IPC.requestMic),
  transcribe: (wav) => ipcRenderer.invoke(IPC.transcribe, wav),
  setVoiceReplies: (enabled) => ipcRenderer.invoke(IPC.setVoiceReplies, enabled),
  stopSpeaking: () => ipcRenderer.invoke(IPC.stopSpeaking),
  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: TutorEvent): void => listener(event)
    ipcRenderer.on(IPC.event, handler)
    return () => {
      ipcRenderer.removeListener(IPC.event, handler)
    }
  }
}

contextBridge.exposeInMainWorld('tutor', bridge)
