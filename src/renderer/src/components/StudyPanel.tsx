import type { KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import type { ChangedFile, Exercise, Interview, Project } from '../../../shared/types'
import ReplPane from './ReplPane'
import InterviewsPane from './InterviewsPane'
import ProjectsPane from './ProjectsPane'
import LibraryPane from './LibraryPane'

export type StudyTab = 'whiteboard' | 'exercise' | 'interviews' | 'projects' | 'library'

export interface WhiteboardState {
  markdown: string
  title?: string
  createdAt?: string
}

interface StudyPanelProps {
  tab: StudyTab
  onTabChange: (tab: StudyTab) => void
  whiteboards: WhiteboardState[]
  whiteboardIndex: number
  onWhiteboardIndexChange: (i: number) => void
  exercises: Exercise[]
  exerciseIndex: number
  onExerciseIndexChange: (i: number) => void
  onCodeSaved: (exerciseId: string, code: string) => void
  sessionId: string | null
  onStudentMessage: (text: string) => void
  interviews: Interview[]
  selectedInterviewId: string | null
  onSelectInterview: (id: string | null) => void
  interviewActive: boolean
  onStudentActivity: () => void
  projects: Project[]
  sessionProject: { project: Project; changes: ChangedFile[] } | null
  onAttachProject: () => void
  onSelectProject: (projectId: string) => void
  onProjectPushModeChange: (projectId: string, mode: Project['pushMode']) => void
  onOpenProject: (projectId: string, target: 'editor' | 'finder') => void
}

/** Formats a whiteboard timestamp: "14:32" for today, "Jul 10" otherwise. */
function formatWhiteboardTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function StudyPanel({
  tab,
  onTabChange,
  whiteboards,
  whiteboardIndex,
  onWhiteboardIndexChange,
  exercises,
  exerciseIndex,
  onExerciseIndexChange,
  onCodeSaved,
  sessionId,
  onStudentMessage,
  interviews,
  selectedInterviewId,
  onSelectInterview,
  interviewActive,
  onStudentActivity,
  projects,
  sessionProject,
  onAttachProject,
  onSelectProject,
  onProjectPushModeChange,
  onOpenProject
}: StudyPanelProps): JSX.Element {
  const hasWhiteboards = whiteboards.length > 0
  const current = hasWhiteboards ? whiteboards[whiteboardIndex] : null
  const atStart = whiteboardIndex <= 0
  const atEnd = whiteboardIndex >= whiteboards.length - 1

  const handleWhiteboardKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!hasWhiteboards) return
    if (e.key === 'ArrowLeft' && !atStart) {
      e.stopPropagation()
      onWhiteboardIndexChange(whiteboardIndex - 1)
    } else if (e.key === 'ArrowRight' && !atEnd) {
      e.stopPropagation()
      onWhiteboardIndexChange(whiteboardIndex + 1)
    }
  }

  const hasExercises = exercises.length > 0
  const currentExercise = hasExercises ? exercises[exerciseIndex] : null
  const exerciseAtStart = exerciseIndex <= 0
  const exerciseAtEnd = exerciseIndex >= exercises.length - 1

  const handleExerciseKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!hasExercises) return
    if (e.key === 'ArrowLeft' && !exerciseAtStart) {
      e.stopPropagation()
      onExerciseIndexChange(exerciseIndex - 1)
    } else if (e.key === 'ArrowRight' && !exerciseAtEnd) {
      e.stopPropagation()
      onExerciseIndexChange(exerciseIndex + 1)
    }
  }

  return (
    <aside className="study-panel">
      <div className="study-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'whiteboard'}
          className={tab === 'whiteboard' ? 'study-tab study-tab-active' : 'study-tab'}
          onClick={() => onTabChange('whiteboard')}
        >
          Whiteboard
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'exercise'}
          className={tab === 'exercise' ? 'study-tab study-tab-active' : 'study-tab'}
          onClick={() => onTabChange('exercise')}
        >
          Exercise
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'interviews'}
          className={tab === 'interviews' ? 'study-tab study-tab-active' : 'study-tab'}
          onClick={() => onTabChange('interviews')}
        >
          {interviewActive && <span className="interview-live-dot" aria-hidden="true" />}
          Interviews
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'projects'}
          className={tab === 'projects' ? 'study-tab study-tab-active' : 'study-tab'}
          onClick={() => onTabChange('projects')}
        >
          Projects
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'library'}
          className={tab === 'library' ? 'study-tab study-tab-active' : 'study-tab'}
          onClick={() => onTabChange('library')}
        >
          Library
        </button>
      </div>

      <div className="study-content">
        {tab === 'whiteboard' &&
          (current === null ? (
            <div className="study-empty">The instructor&apos;s whiteboard will appear here.</div>
          ) : (
            <div
              className="whiteboard-wrap"
              tabIndex={0}
              onKeyDown={handleWhiteboardKeyDown}
            >
              <div className="whiteboard-history-bar">
                <button
                  type="button"
                  className="whiteboard-nav-btn"
                  disabled={atStart}
                  onClick={() => onWhiteboardIndexChange(whiteboardIndex - 1)}
                  aria-label="Previous whiteboard"
                >
                  ◀
                </button>
                <span className="whiteboard-history-counter">
                  {whiteboardIndex + 1} / {whiteboards.length}
                </span>
                <button
                  type="button"
                  className="whiteboard-nav-btn"
                  disabled={atEnd}
                  onClick={() => onWhiteboardIndexChange(whiteboardIndex + 1)}
                  aria-label="Next whiteboard"
                >
                  ▶
                </button>
                {current.createdAt !== undefined && (
                  <span className="whiteboard-history-time">
                    {formatWhiteboardTime(current.createdAt)}
                  </span>
                )}
              </div>
              <div className="whiteboard markdown-body">
                {current.title !== undefined && current.title !== '' && (
                  <h2 className="whiteboard-title">{current.title}</h2>
                )}
                <ReactMarkdown>{current.markdown}</ReactMarkdown>
              </div>
            </div>
          ))}

        {tab === 'exercise' && (!hasExercises || sessionId === null) && (
          <div className="study-empty">Assigned exercises will appear here.</div>
        )}

        {tab === 'exercise' && hasExercises && currentExercise !== null && (
          <div
            className="whiteboard-wrap"
            tabIndex={0}
            onKeyDown={handleExerciseKeyDown}
          >
            <div className="whiteboard-history-bar">
              <button
                type="button"
                className="whiteboard-nav-btn"
                disabled={exerciseAtStart}
                onClick={() => onExerciseIndexChange(exerciseIndex - 1)}
                aria-label="Previous exercise"
              >
                ◀
              </button>
              <span className="whiteboard-history-counter">
                {exerciseIndex + 1} / {exercises.length}
              </span>
              <button
                type="button"
                className="whiteboard-nav-btn"
                disabled={exerciseAtEnd}
                onClick={() => onExerciseIndexChange(exerciseIndex + 1)}
                aria-label="Next exercise"
              >
                ▶
              </button>
              <span className="exercise-history-title">{currentExercise.title}</span>
              <span className="whiteboard-history-time">
                {formatWhiteboardTime(currentExercise.createdAt)}
              </span>
            </div>
          </div>
        )}

        {tab === 'interviews' && (
          <InterviewsPane
            sessionId={sessionId}
            interviews={interviews}
            selectedId={selectedInterviewId}
            onSelect={onSelectInterview}
          />
        )}

        {tab === 'projects' && (
          <ProjectsPane
            projects={projects}
            sessionProject={sessionProject}
            sessionId={sessionId}
            onAttach={onAttachProject}
            onSelectProject={onSelectProject}
            onPushModeChange={onProjectPushModeChange}
            onOpen={onOpenProject}
            onStudentMessage={onStudentMessage}
          />
        )}

        {tab === 'library' && <LibraryPane onStudentMessage={onStudentMessage} />}

        {/* The REPL stays mounted across tab switches (just hidden on the
            whiteboard tab) so editor content, scroll position, and pending
            autosaves survive flipping between Whiteboard and Exercise. */}
        {hasExercises && currentExercise !== null && sessionId !== null && (
          <div
            className={
              tab === 'exercise' ? 'study-keepalive' : 'study-keepalive study-keepalive-hidden'
            }
          >
            <ReplPane
              key={currentExercise.id}
              sessionId={sessionId}
              exercise={currentExercise}
              onStudentMessage={onStudentMessage}
              onCodeSaved={onCodeSaved}
              onStudentActivity={onStudentActivity}
            />
          </div>
        )}
      </div>
    </aside>
  )
}
