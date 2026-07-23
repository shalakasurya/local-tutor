import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { watch } from 'fs'
import type { FSWatcher } from 'fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, join, resolve, sep } from 'path'
import type { ChangedFile, DbApi, Project, TutorEvent } from '../shared/types'
import {
  changedFiles,
  checkpoint,
  diffSinceCheckpoint,
  initShadow,
  listFiles,
  type ShadowRepo
} from './shadow'

const WATCH_DEBOUNCE_MS = 1500
const PUSH_SETTLE_MS = 45_000
const PUSH_THROTTLE_MS = 5 * 60_000
const SCAFFOLD_TIMEOUT_MS = 120_000
const READ_CAP_BYTES = 50_000
const DIFF_CAP_BYTES = 24_000

const IGNORED_SEGMENTS = ['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage']
const SECRET_PATH = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|.*secret.*|.*credential.*)$/i

function isIgnoredWatchPath(relPath: string): boolean {
  const parts = relPath.split(sep)
  return (
    parts.some((p) => IGNORED_SEGMENTS.includes(p)) ||
    relPath.endsWith('.log') ||
    relPath.endsWith('.DS_Store')
  )
}

/** Hooks into the rest of the app, late-bound to avoid construction cycles. */
export interface ProjectHooks {
  isBusy: (sessionId: string) => boolean
  hasActiveInterview: (sessionId: string) => boolean
  /** Inject a hidden note to the instructor (streams a spoken reply as usual). */
  injectNote: (sessionId: string, note: string) => void
  getWindow: () => BrowserWindow | null
}

export class ProjectsService {
  private watchers = new Map<string, FSWatcher>()
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private pushTimers = new Map<string, NodeJS.Timeout>()
  private lastPushAt = new Map<string, number>()
  private pendingScaffolds = new Map<string, (approved: boolean) => void>()

  constructor(
    private db: DbApi,
    private shadowRoot: string,
    private emit: (event: TutorEvent) => void,
    private hooks: ProjectHooks
  ) {}

  private repo(project: Project): ShadowRepo {
    return { gitDir: join(this.shadowRoot, `${project.id}.git`), workTree: project.path }
  }

  /** Start watchers for every known project (call once at app startup). */
  startAll(): void {
    for (const project of this.db.listProjects()) {
      this.startWatcher(project)
    }
  }

  // ---------- Registration ----------

  private async register(name: string, dirPath: string, sessionId: string): Promise<Project> {
    let project = this.db.getProjectByPath(dirPath)
    if (!project) {
      project = this.db.createProject({ name, path: dirPath })
      await initShadow(this.repo(project))
      // Baseline snapshot: "changes" are measured from the moment of attachment.
      await checkpoint(this.repo(project), 'baseline')
      this.db.touchProjectCheckpoint(project.id, new Date().toISOString())
    }
    this.db.linkSessionProject(sessionId, project.id)
    this.startWatcher(project)
    this.emit({ type: 'project-linked', sessionId, project })
    return project
  }

  private async pickDirectory(title: string): Promise<string | null> {
    const win = this.hooks.getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title,
      buttonLabel: 'Choose',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }

  /** Tutor tool flow: student picks a parent folder; we create <parent>/<slug>. Null = cancelled. */
  async createViaPicker(name: string, sessionId: string): Promise<Project | null> {
    const parent = await this.pickDirectory(`Choose where to create the "${name}" project`)
    if (!parent) return null
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'project'
    const dirPath = join(parent, slug)
    await mkdir(dirPath, { recursive: true })
    return this.register(name, dirPath, sessionId)
  }

  /** UI flow: attach an existing directory. Null = cancelled. */
  async attachViaPicker(sessionId: string): Promise<Project | null> {
    const dirPath = await this.pickDirectory('Choose a project folder to attach')
    if (!dirPath) return null
    return this.register(basename(dirPath), dirPath, sessionId)
  }

  // ---------- Watching & push mode ----------

  private startWatcher(project: Project): void {
    if (this.watchers.has(project.id)) return
    try {
      const watcher = watch(project.path, { recursive: true }, (_event, filename) => {
        if (filename && isIgnoredWatchPath(String(filename))) return
        this.scheduleBurst(project.id)
      })
      watcher.on('error', () => this.stopWatcher(project.id))
      this.watchers.set(project.id, watcher)
    } catch {
      // Directory missing/unreadable — project effectively dormant.
    }
  }

  private stopWatcher(projectId: string): void {
    this.watchers.get(projectId)?.close()
    this.watchers.delete(projectId)
  }

  private scheduleBurst(projectId: string): void {
    const existing = this.debounceTimers.get(projectId)
    if (existing) clearTimeout(existing)
    this.debounceTimers.set(
      projectId,
      setTimeout(() => {
        this.debounceTimers.delete(projectId)
        void this.onBurst(projectId)
      }, WATCH_DEBOUNCE_MS)
    )
    // Push-mode timer: (re)starts on every burst so it fires only after edits settle.
    const pushTimer = this.pushTimers.get(projectId)
    if (pushTimer) clearTimeout(pushTimer)
    this.pushTimers.set(
      projectId,
      setTimeout(() => {
        this.pushTimers.delete(projectId)
        void this.maybePushComment(projectId)
      }, PUSH_SETTLE_MS)
    )
  }

  private async onBurst(projectId: string): Promise<void> {
    const project = this.db.getProject(projectId)
    if (!project) return
    const files = await changedFiles(this.repo(project))
    const sessionId = this.db.getProjectSession(projectId) ?? ''
    this.emit({ type: 'project-changes', sessionId, projectId, files })
  }

  private async maybePushComment(projectId: string): Promise<void> {
    const project = this.db.getProject(projectId)
    if (!project || project.pushMode !== 'active') return
    const sessionId = this.db.getProjectSession(projectId)
    if (!sessionId) return
    if (this.hooks.isBusy(sessionId) || this.hooks.hasActiveInterview(sessionId)) return
    const last = this.lastPushAt.get(projectId) ?? 0
    if (Date.now() - last < PUSH_THROTTLE_MS) return
    const files = await changedFiles(this.repo(project))
    if (files.length === 0) return
    this.lastPushAt.set(projectId, Date.now())
    const fileList = files
      .slice(0, 20)
      .map((f) => f.path)
      .join(', ')
    this.hooks.injectNote(
      sessionId,
      `The student has been editing the project "${project.name}" in their external editor and has paused. ` +
        `Files changed since you last looked: ${fileList}. As their pair-programming teammate, look at the ` +
        `changes (get_project_changes, read_project_file) and briefly comment out loud — one to three spoken ` +
        `sentences with a specific observation, question, or piece of encouragement. If the changes look ` +
        `mid-edit or trivial, just ask lightly what they're working toward. Do not mention this reminder.`
    )
  }

  // ---------- Tool-facing operations ----------

  linkedProject(sessionId: string): Project | null {
    return this.db.getSessionProject(sessionId)
  }

  async currentChanges(project: Project): Promise<ChangedFile[]> {
    return changedFiles(this.repo(project))
  }

  async projectFiles(project: Project): Promise<string[]> {
    return listFiles(this.repo(project))
  }

  async readProjectFile(project: Project, relPath: string): Promise<string> {
    const abs = resolve(project.path, relPath)
    if (!abs.startsWith(project.path + sep) && abs !== project.path) {
      throw new Error('Path escapes the project directory')
    }
    if (SECRET_PATH.test(relPath)) {
      return '[redacted: this file looks like it contains secrets]'
    }
    const info = await stat(abs)
    if (info.size > READ_CAP_BYTES) {
      const content = await readFile(abs, 'utf8')
      return content.slice(0, READ_CAP_BYTES) + '\n…[truncated]'
    }
    return readFile(abs, 'utf8')
  }

  /** Diff since last review, then checkpoint (this look becomes the new baseline). */
  async reviewChanges(project: Project): Promise<string> {
    const repo = this.repo(project)
    const diff = await diffSinceCheckpoint(repo, DIFF_CAP_BYTES)
    await checkpoint(repo, 'tutor review')
    this.db.touchProjectCheckpoint(project.id, new Date().toISOString())
    // The change list is now empty — let the UI clear its badge.
    const sessionId = this.db.getProjectSession(project.id) ?? ''
    this.emit({ type: 'project-changes', sessionId, projectId: project.id, files: [] })
    return diff
  }

  /** Ask the student (approval modal) and, if approved, write the files. */
  async scaffold(
    sessionId: string,
    project: Project,
    summary: string,
    files: Array<{ path: string; content: string }>
  ): Promise<boolean> {
    for (const file of files) {
      const abs = resolve(project.path, file.path)
      if (!abs.startsWith(project.path + sep)) {
        throw new Error(`Invalid scaffold path: ${file.path}`)
      }
      if (SECRET_PATH.test(file.path)) {
        throw new Error(`Refusing to write a secret-shaped file: ${file.path}`)
      }
    }
    const requestId = randomUUID()
    const approved = await new Promise<boolean>((resolvePromise) => {
      this.pendingScaffolds.set(requestId, resolvePromise)
      this.emit({ type: 'scaffold-request', sessionId, requestId, projectId: project.id, summary, files })
      setTimeout(() => {
        if (this.pendingScaffolds.has(requestId)) {
          this.pendingScaffolds.delete(requestId)
          resolvePromise(false)
        }
      }, SCAFFOLD_TIMEOUT_MS)
    })
    if (!approved) return false
    for (const file of files) {
      const abs = resolve(project.path, file.path)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, file.content)
    }
    await checkpoint(this.repo(project), 'tutor scaffold')
    this.db.touchProjectCheckpoint(project.id, new Date().toISOString())
    return true
  }

  respondScaffold(requestId: string, approved: boolean): void {
    const resolver = this.pendingScaffolds.get(requestId)
    if (resolver) {
      this.pendingScaffolds.delete(requestId)
      resolver(approved)
    }
  }

  // ---------- Misc UI actions ----------

  openIn(project: Project, target: 'editor' | 'finder'): void {
    if (target === 'finder') {
      void shell.openPath(project.path)
      return
    }
    execFile('code', [project.path], (err) => {
      if (err) void shell.openPath(project.path)
    })
  }

  /** Hidden per-message context: which files changed since the tutor last looked. */
  projectNoteFor(sessionId: string): string | null {
    const project = this.db.getSessionProject(sessionId)
    if (!project) return null
    // Synchronous surface for the instructor; keep it cheap — names only.
    // (Async would complicate the send path; the tool fetches real diffs.)
    return `The session is linked to the project "${project.name}" at ${project.path}. If the student's message concerns their project code, use get_project_changes / read_project_file to look at the actual current code before answering.`
  }
}
