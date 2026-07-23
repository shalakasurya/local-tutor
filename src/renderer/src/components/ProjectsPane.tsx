import type { ChangedFile, Project } from '../../../shared/types'

interface ProjectsPaneProps {
  projects: Project[]
  sessionProject: { project: Project; changes: ChangedFile[] } | null
  sessionId: string | null
  onAttach: () => void
  onPushModeChange: (projectId: string, mode: Project['pushMode']) => void
  onOpen: (projectId: string, target: 'editor' | 'finder') => void
  onStudentMessage: (text: string) => void
}

/** Truncates the middle of a long path, keeping the start and end (the most
 *  identifying parts) readable. The full path is always available via title. */
function truncateMiddle(path: string, max = 46): string {
  if (path.length <= max) return path
  const keep = max - 1 // reserve one character for the ellipsis
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`
}

/** Formats a creation date: "Jul 10". Projects don't need same-day time precision
 *  the way transcript/whiteboard timestamps do. */
function formatProjectDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Git porcelain status strings are two chars (e.g. "??", " M", "A "); collapse
 *  to the single meaningful character for compact display. */
function changedFileStatusChar(status: string): string {
  const trimmed = status.trim()
  return trimmed === '' ? status : trimmed
}

function changedFileStatusClass(status: string): string {
  if (status.includes('?')) return 'changed-file-status-new'
  if (status.includes('M')) return 'changed-file-status-modified'
  return 'changed-file-status-other'
}

function ChangedFileRow({ file }: { file: ChangedFile }): JSX.Element {
  return (
    <div className="changed-file-row">
      <span className={`changed-file-status ${changedFileStatusClass(file.status)}`}>
        {changedFileStatusChar(file.status)}
      </span>
      <span className="changed-file-path">{file.path}</span>
    </div>
  )
}

function ActiveProjectCard({
  sessionProject,
  onPushModeChange,
  onOpen,
  onStudentMessage
}: {
  sessionProject: { project: Project; changes: ChangedFile[] }
  onPushModeChange: (projectId: string, mode: Project['pushMode']) => void
  onOpen: (projectId: string, target: 'editor' | 'finder') => void
  onStudentMessage: (text: string) => void
}): JSX.Element {
  const { project, changes } = sessionProject
  const pushActive = project.pushMode === 'active'

  return (
    <div className="active-project-card">
      <div className="active-project-header">
        <span className="active-project-name">{project.name}</span>
        <span className="active-project-path" title={project.path}>
          {truncateMiddle(project.path)}
        </span>
      </div>

      <div className="changed-files-list">
        {changes.length === 0 ? (
          <div className="study-empty changed-files-empty">No changes since the last review</div>
        ) : (
          changes.map((file) => <ChangedFileRow key={file.path} file={file} />)
        )}
      </div>

      <div className="active-project-actions">
        <button
          type="button"
          className="review-now-btn"
          onClick={() => onStudentMessage('Please review my latest project changes.')}
        >
          Review changes
        </button>
        <button
          type="button"
          className="project-btn"
          onClick={() => onOpen(project.id, 'editor')}
        >
          Open in editor
        </button>
        <button
          type="button"
          className="project-btn"
          onClick={() => onOpen(project.id, 'finder')}
        >
          Show in Finder
        </button>
      </div>

      <div className="project-push-mode">
        <button
          type="button"
          className={`voice-toggle${pushActive ? ' voice-toggle-on' : ''}`}
          onClick={() => onPushModeChange(project.id, pushActive ? 'quiet' : 'active')}
          aria-pressed={pushActive}
        >
          <span className="voice-toggle-switch" />
          Pair-programming comments
        </button>
        <div className="project-push-mode-hint">
          When on, the tutor may speak up on its own after you pause editing.
        </div>
      </div>
    </div>
  )
}

function ProjectRow({ project, active }: { project: Project; active: boolean }): JSX.Element {
  return (
    <div className={active ? 'project-row project-row-active' : 'project-row'}>
      <div className="project-row-main">
        <span className="project-row-name">{project.name}</span>
        <span className="project-row-path" title={project.path}>
          {truncateMiddle(project.path, 40)}
        </span>
      </div>
      <span className="project-row-date">{formatProjectDate(project.createdAt)}</span>
    </div>
  )
}

export default function ProjectsPane({
  projects,
  sessionProject,
  sessionId,
  onAttach,
  onPushModeChange,
  onOpen,
  onStudentMessage
}: ProjectsPaneProps): JSX.Element {
  const attachDisabled = sessionId === null

  return (
    <div className="projects-pane">
      {sessionProject !== null && (
        <ActiveProjectCard
          sessionProject={sessionProject}
          onPushModeChange={onPushModeChange}
          onOpen={onOpen}
          onStudentMessage={onStudentMessage}
        />
      )}

      <div className="projects-list-section">
        <div className="projects-list-header">
          <span className="projects-list-title">All projects</span>
          <button
            type="button"
            className="project-btn"
            onClick={onAttach}
            disabled={attachDisabled}
            title={attachDisabled ? 'Select a session first' : undefined}
          >
            Attach folder…
          </button>
        </div>

        {projects.length === 0 && sessionProject === null ? (
          <div className="study-empty">
            No projects yet — ask your tutor to start one, or attach a folder.
          </div>
        ) : (
          <div className="projects-list">
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                active={sessionProject !== null && sessionProject.project.id === project.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
