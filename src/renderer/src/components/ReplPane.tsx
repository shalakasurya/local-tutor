import { useCallback, useEffect, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import type { Extension } from '@uiw/react-codemirror'
import ReactMarkdown from 'react-markdown'
import type { Exercise, RunResult } from '../../../shared/types'

interface ReplPaneProps {
  sessionId: string
  exercise: Exercise
  onStudentMessage: (text: string) => void
  onCodeSaved: (exerciseId: string, code: string) => void
  onStudentActivity: () => void
}

interface ConsoleLine {
  level: 'log' | 'warn' | 'error'
  text: string
}

// How long to wait after a 'web' run for the iframe's load-time console messages to
// arrive over postMessage. This is only the *initial* settle: the preview keeps logging
// for as long as the student interacts with it, and those later lines are pushed to the
// instructor by the refresh effect below rather than being lost.
const WEB_CONSOLE_SETTLE_MS = 800

// Floors for the drag-to-resize split between the requirements section and the editor.
// Neither side can be dragged away entirely. The prompt floor applies to its scrolling
// text area only — the title row sits outside that and is always visible.
const MIN_PROMPT_BODY_HEIGHT = 40
const MIN_EDITOR_HEIGHT = 120
// Distance one arrow-key press moves the divider.
const SPLITTER_KEY_STEP = 16

function formatConsoleLines(lines: ConsoleLine[]): string {
  if (lines.length === 0) {
    // Deliberately "yet": an empty console usually means the student hasn't interacted
    // with the preview, not that their code produced nothing. Phrasing it as a final
    // verdict invites the instructor to diagnose a working program as broken.
    return '(no console output yet — the student may not have interacted with the preview)'
  }
  return lines.map((line) => `${line.level}: ${line.text}`).join('\n')
}

function languageExtension(language: string): Extension[] {
  const lang = language.toLowerCase()
  switch (lang) {
    case 'html':
      return [html()]
    case 'css':
      return [css()]
    case 'typescript':
      return [javascript({ jsx: false, typescript: true })]
    case 'tsx':
      return [javascript({ jsx: true, typescript: true })]
    case 'jsx':
      return [javascript({ jsx: true, typescript: false })]
    case 'javascript':
    default:
      return [javascript({ jsx: false, typescript: false })]
  }
}

export default function ReplPane({
  sessionId,
  exercise,
  onStudentMessage,
  onCodeSaved,
  onStudentActivity
}: ReplPaneProps): JSX.Element {
  const [code, setCode] = useState(exercise.solutionCode ?? exercise.starterCode)
  const [promptOpen, setPromptOpen] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([])
  const [outputOpen, setOutputOpen] = useState(false)

  // Accumulator ref so the delayed 'web' report reads freshly-captured console lines.
  const consoleLinesRef = useRef<ConsoleLine[]>([])
  // Tracks whether the current `code` has ever been run/reported, and whether it has
  // been edited since the last run — used by "Submit for review" to decide whether to
  // run again first.
  const hasRunRef = useRef(false)
  const dirtyRef = useRef(true)
  // The code that produced the currently-displayed result, and whether that result is a
  // 'web' one. Console refreshes must report the code that actually ran, not whatever is
  // in the editor now, and only web runs keep producing output after the initial report.
  const ranCodeRef = useRef('')
  const isWebRunRef = useRef(false)

  // ---------- Resizable requirements/editor split ----------
  // null = size to content (the original behaviour); a number pins the requirements
  // *text area* to that pixel height and lets the editor take the rest. Deliberately not
  // persisted: the split resets whenever the exercise changes.
  //
  // The height goes on the inner text div, never on the <details>. Chromium renders
  // <details> through UA shadow-DOM slots, so the light-DOM children aren't its layout
  // children — sizing the <details> and expecting an inner `flex: 1; overflow: auto` child
  // to absorb it silently fails, and the text spills out over the toolbar and editor.
  const [promptHeight, setPromptHeight] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const replRef = useRef<HTMLDivElement>(null)
  const promptBodyRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  // Set on pointer-down so the drag maths don't have to re-measure the fixed chrome
  // (toolbar, divider, flex gaps) on every pointermove.
  const dragRef = useRef<{ startY: number; startHeight: number; maxHeight: number } | null>(null)

  // Re-initialize editor content when the exercise changes. Deliberately keyed only on
  // exercise.id: onCodeSaved (below) writes autosaves back into the parent's exercise
  // object's solutionCode, and including solutionCode/starterCode here would re-fire
  // this effect after every autosave, wiping the run result and closing the output
  // modal mid-session. The component is also keyed by exercise.id (see StudyPanel), so
  // id is the only meaningful trigger.
  useEffect(() => {
    setCode(exercise.solutionCode ?? exercise.starterCode)
    setResult(null)
    setConsoleLines([])
    consoleLinesRef.current = []
    hasRunRef.current = false
    dirtyRef.current = true
    ranCodeRef.current = ''
    isWebRunRef.current = false
    setPromptHeight(null)
    setPromptOpen(true)
    setOutputOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise.id])

  // Capture console messages posted from the sandboxed iframe.
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const data = event.data as unknown
      if (
        typeof data === 'object' &&
        data !== null &&
        '__tutorConsole' in data &&
        (data as { __tutorConsole?: unknown }).__tutorConsole === true
      ) {
        const { level, text } = data as { level?: unknown; text?: unknown }
        const safeLevel: ConsoleLine['level'] =
          level === 'warn' || level === 'error' ? level : 'log'
        const line: ConsoleLine = { level: safeLevel, text: typeof text === 'string' ? text : '' }
        consoleLinesRef.current = [...consoleLinesRef.current, line]
        setConsoleLines(consoleLinesRef.current)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  // Close the output modal on Escape, without leaking the keypress to other
  // window-level Escape handlers (e.g. Composer's recording-cancel handler).
  // Listener is only attached while the modal is open.
  useEffect(() => {
    if (!outputOpen) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOutputOpen(false)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [outputOpen])

  // Remounting a 'web' result's iframe re-executes the code and replays its
  // console postMessages — clear captured lines whenever the modal opens on a
  // web result so the replay repopulates them without duplicates.
  useEffect(() => {
    if (outputOpen && result !== null && result.kind === 'web') {
      consoleLinesRef.current = []
      setConsoleLines([])
    }
  }, [outputOpen, result])

  const handleChange = useCallback(
    (value: string) => {
      setCode(value)
      dirtyRef.current = true
      onStudentActivity()
    },
    [onStudentActivity]
  )

  const handleReset = useCallback(() => {
    if (!window.confirm('Discard your changes and restore the starter code?')) return
    setCode(exercise.starterCode)
    dirtyRef.current = true
  }, [exercise.starterCode])

  // ---------- Autosave ----------
  // Persist edits as the student types (debounced), so switching sessions or
  // exercises never loses code that was never Run. savedCodeRef tracks what's
  // already on disk to avoid redundant writes.
  const codeRef = useRef(code)
  codeRef.current = code
  const savedCodeRef = useRef(code)

  // New exercise → reset the on-disk baseline to what we just loaded.
  useEffect(() => {
    savedCodeRef.current = exercise.solutionCode ?? exercise.starterCode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise.id])

  // Debounced save 600ms after the last keystroke.
  useEffect(() => {
    if (code === savedCodeRef.current) return
    const timer = setTimeout(() => {
      const toSave = code
      savedCodeRef.current = toSave
      window.tutor
        .saveExerciseCode(exercise.id, toSave)
        .then(() => onCodeSaved(exercise.id, toSave))
        .catch(() => {})
    }, 600)
    return () => clearTimeout(timer)
  }, [code, exercise.id, onCodeSaved])

  // Flush any not-yet-saved edits when the exercise switches or the pane unmounts
  // (cleanup runs before the new exercise's effects, so refs still hold old values).
  useEffect(() => {
    const exerciseId = exercise.id
    return () => {
      if (codeRef.current !== savedCodeRef.current) {
        const toSave = codeRef.current
        window.tutor
          .saveExerciseCode(exerciseId, toSave)
          .then(() => onCodeSaved(exerciseId, toSave))
          .catch(() => {})
        savedCodeRef.current = toSave
      }
    }
  }, [exercise.id, onCodeSaved])

  // Refreshes the instructor's copy of the last run's console output. reportRun overwrites
  // the session's single latest-run slot (see main/ipc.ts), so this replaces the previous
  // snapshot rather than adding an entry — safe to call repeatedly.
  const pushConsoleReport = useCallback(async (): Promise<void> => {
    try {
      await window.tutor.reportRun({
        sessionId,
        exerciseId: exercise.id,
        code: ranCodeRef.current,
        output: formatConsoleLines(consoleLinesRef.current)
      })
    } catch {
      // A failed refresh just leaves the previous snapshot in place.
    }
  }, [sessionId, exercise.id])

  // Runs the current code, displays the result, and reports it to the instructor.
  // Returns once the report has been sent.
  const runAndReport = useCallback(async (): Promise<void> => {
    onStudentActivity()
    consoleLinesRef.current = []
    setConsoleLines([])
    setRunning(true)
    setOutputOpen(true)
    try {
      const runResult = await window.tutor.runCode({ language: exercise.language, code })
      setResult(runResult)
      ranCodeRef.current = code
      isWebRunRef.current = runResult.kind === 'web'

      let output: string
      if (runResult.kind === 'node') {
        output =
          runResult.stdout +
          (runResult.stderr ? '\n[stderr]\n' + runResult.stderr : '') +
          (runResult.timedOut ? '\n[timed out]' : '')
      } else if (runResult.kind === 'error') {
        output = 'Build error: ' + runResult.message
      } else {
        // 'web' — wait for the iframe's load-time console messages to arrive via
        // postMessage. Anything logged later (clicks, typing, async work) is picked up by
        // the refresh effect below, so this snapshot is a starting point, not the whole run.
        await new Promise((resolve) => setTimeout(resolve, WEB_CONSOLE_SETTLE_MS))
        output = formatConsoleLines(consoleLinesRef.current)
      }

      await window.tutor.reportRun({ sessionId, exerciseId: exercise.id, code, output })
      hasRunRef.current = true
      dirtyRef.current = false
      onCodeSaved(exercise.id, code)
    } finally {
      setRunning(false)
    }
  }, [code, exercise.id, exercise.language, sessionId, onCodeSaved, onStudentActivity])

  // Keep the instructor's view of a web run current. The preview iframe keeps posting
  // console messages for as long as the student interacts with it, so the snapshot taken
  // right after Run goes stale the moment they click anything. Without this, the
  // instructor inspects a run and sees only the first WEB_CONSOLE_SETTLE_MS of output —
  // which reads as "your code logged nothing" for any handler-driven log.
  useEffect(() => {
    if (!hasRunRef.current || !isWebRunRef.current || consoleLines.length === 0) return
    const timer = setTimeout(() => {
      void pushConsoleReport()
    }, 400)
    return () => clearTimeout(timer)
  }, [consoleLines, pushConsoleReport])

  const handleRun = useCallback(() => {
    void runAndReport()
  }, [runAndReport])

  const handleSubmit = useCallback(() => {
    void (async () => {
      if (!hasRunRef.current || dirtyRef.current) {
        await runAndReport()
      } else if (isWebRunRef.current) {
        // No re-run needed, but the student may have exercised the preview since the run.
        // Flush the latest console before asking for review, so the instructor grades what
        // actually happened rather than the state of the page at load.
        await pushConsoleReport()
      }
      onStudentMessage("I've submitted my solution for the current exercise — please review it.")
    })()
  }, [runAndReport, pushConsoleReport, onStudentMessage])

  const handleShowLastOutput = useCallback(() => {
    setOutputOpen(true)
  }, [])

  const handleCloseOutput = useCallback(() => {
    setOutputOpen(false)
  }, [])

  const handleScrimClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      setOutputOpen(false)
    }
  }, [])

  // ---------- Divider drag ----------
  // How tall the requirements text can grow before the editor hits its floor. Everything
  // else on screen (title row, toolbar, divider, gaps) is fixed, so whatever the text area
  // takes it takes from the editor and nothing else — which reduces to the editor's
  // current slack plus the text area's current height.
  const maxPromptHeight = useCallback((): number => {
    const bodyEl = promptBodyRef.current
    const editorEl = editorRef.current
    if (!bodyEl || !editorEl) return Number.POSITIVE_INFINITY
    const bodyH = bodyEl.getBoundingClientRect().height
    const editorH = editorEl.getBoundingClientRect().height
    return Math.max(MIN_PROMPT_BODY_HEIGHT, bodyH + editorH - MIN_EDITOR_HEIGHT)
  }, [])

  const handleSplitterPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const bodyEl = promptBodyRef.current
      if (!bodyEl) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = {
        startY: event.clientY,
        startHeight: bodyEl.getBoundingClientRect().height,
        maxHeight: maxPromptHeight()
      }
      setResizing(true)
    },
    [maxPromptHeight]
  )

  const handleSplitterPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const next = drag.startHeight + (event.clientY - drag.startY)
    setPromptHeight(Math.min(Math.max(next, MIN_PROMPT_BODY_HEIGHT), drag.maxHeight))
  }, [])

  const handleSplitterPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
    setResizing(false)
  }, [])

  // Double-click the divider to go back to sizing the requirements to its content.
  const handleSplitterDoubleClick = useCallback(() => {
    setPromptHeight(null)
  }, [])

  const handleSplitterKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const bodyEl = promptBodyRef.current
      if (!bodyEl) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? SPLITTER_KEY_STEP : -SPLITTER_KEY_STEP
      const current = promptHeight ?? bodyEl.getBoundingClientRect().height
      setPromptHeight(
        Math.min(Math.max(current + delta, MIN_PROMPT_BODY_HEIGHT), maxPromptHeight())
      )
    },
    [promptHeight, maxPromptHeight]
  )

  // Only meaningful while the requirements section is expanded — there's nothing to
  // resize against a collapsed <details>.
  const sized = promptOpen && promptHeight !== null

  return (
    <div className="repl" ref={replRef} data-resizing={resizing ? 'true' : undefined}>
      <details
        className="repl-prompt"
        data-sized={sized ? 'true' : undefined}
        open={promptOpen}
        onToggle={(event) => setPromptOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary className="repl-prompt-summary">{exercise.title}</summary>
        <div
          className="exercise-prompt markdown-body"
          ref={promptBodyRef}
          style={sized ? { height: promptHeight ?? undefined } : undefined}
        >
          <ReactMarkdown>{exercise.promptMd}</ReactMarkdown>
        </div>
      </details>

      {promptOpen && (
        <div
          className="repl-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the requirements section"
          tabIndex={0}
          onPointerDown={handleSplitterPointerDown}
          onPointerMove={handleSplitterPointerMove}
          onPointerUp={handleSplitterPointerUp}
          onPointerCancel={handleSplitterPointerUp}
          onDoubleClick={handleSplitterDoubleClick}
          onKeyDown={handleSplitterKeyDown}
          title="Drag to resize · double-click to fit the text"
        />
      )}

      <div className="repl-toolbar">
        <div className="repl-toolbar-left">
          <span className="repl-title">{exercise.title}</span>
          <span className="repl-lang-badge">{exercise.language}</span>
        </div>
        <div className="repl-toolbar-right">
          <button type="button" className="repl-btn repl-btn-reset" onClick={handleReset}>
            Reset
          </button>
          {result !== null && (
            <button
              type="button"
              className="repl-btn repl-btn-last-output"
              onClick={handleShowLastOutput}
            >
              Last output
            </button>
          )}
          <button
            type="button"
            className="repl-btn repl-btn-run"
            onClick={handleRun}
            disabled={running}
          >
            {running ? 'Running…' : '▶ Run'}
          </button>
          <button type="button" className="repl-btn repl-btn-submit" onClick={handleSubmit}>
            Submit for review
          </button>
        </div>
      </div>

      <div className="repl-editor" ref={editorRef}>
        <CodeMirror
          value={code}
          height="100%"
          theme="dark"
          extensions={languageExtension(exercise.language)}
          onChange={handleChange}
        />
      </div>

      {outputOpen && (
        <div className="repl-output-scrim" onClick={handleScrimClick}>
          <div className="repl-output-modal">
            <div className="repl-output-modal-header">
              <span className="repl-output-modal-title">
                Run output <span className="repl-output-modal-subtitle">{exercise.title}</span>
              </span>
              <button
                type="button"
                className="repl-output-modal-close"
                onClick={handleCloseOutput}
                aria-label="Close output"
              >
                ✕
              </button>
            </div>
            <div className="repl-output-modal-body">
              {running && <div className="repl-output-status">Running…</div>}

              {!running && result === null && (
                <div className="repl-output-empty">Run your code to see output here.</div>
              )}

              {!running && result !== null && result.kind === 'node' && (
                <div className="repl-output-node">
                  {result.timedOut && (
                    <div className="repl-output-timeout">⏱ Timed out after 5s</div>
                  )}
                  {result.stdout !== '' && <pre className="repl-stdout">{result.stdout}</pre>}
                  {result.stderr !== '' && <pre className="repl-stderr">{result.stderr}</pre>}
                  <div className="repl-output-footer">
                    exit code: {result.exitCode ?? 'n/a'} · {result.durationMs}ms
                  </div>
                </div>
              )}

              {!running && result !== null && result.kind === 'error' && (
                <pre className="repl-output-error">Build error: {result.message}</pre>
              )}

              {!running && result !== null && result.kind === 'web' && (
                <div className="repl-output-web">
                  {/*
                    allow-forms: without it the form-submission algorithm bails before firing the
                    submit event, so React's onSubmit never runs — silently, since the browser's
                    own block message doesn't route through CONSOLE_CAPTURE_SCRIPT.
                    allow-modals: re-enables alert/confirm/prompt in the student's code.
                    Neither widens the sandbox meaningfully: without allow-same-origin the frame
                    stays on an opaque origin, and allow-scripts already permits fetch().
                  */}
                  <iframe
                    className="repl-iframe"
                    sandbox="allow-scripts allow-forms allow-modals"
                    srcDoc={result.html}
                    title="Exercise output"
                  />
                  <div className="repl-console">
                    {consoleLines.length === 0 ? (
                      <div className="repl-console-empty">(no console output)</div>
                    ) : (
                      consoleLines.map((line, index) => (
                        <div
                          key={index}
                          className={`repl-console-line repl-console-${line.level}`}
                        >
                          {line.level}: {line.text}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
