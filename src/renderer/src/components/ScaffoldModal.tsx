import { useEffect, useState } from 'react'

interface ScaffoldFile {
  path: string
  content: string
}

interface ScaffoldModalProps {
  request: {
    requestId: string
    summary: string
    files: ScaffoldFile[]
  }
  onRespond: (requestId: string, approved: boolean) => void
}

export default function ScaffoldModal({ request, onRespond }: ScaffoldModalProps): JSX.Element {
  const [selectedPath, setSelectedPath] = useState<string>(request.files[0]?.path ?? '')

  // Re-select the first file whenever a new request comes in.
  useEffect(() => {
    setSelectedPath(request.files[0]?.path ?? '')
  }, [request.requestId, request.files])

  // Escape rejects the request. No scrim-click dismissal — approving/rejecting file
  // writes is a decision the student must make explicitly. Listener uses capture
  // (like the REPL output modal) so it doesn't leak to other window-level handlers.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onRespond(request.requestId, false)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [request.requestId, onRespond])

  const selected = request.files.find((f) => f.path === selectedPath) ?? request.files[0] ?? null

  return (
    <div className="repl-output-scrim">
      <div className="repl-output-modal scaffold-modal">
        <div className="repl-output-modal-header">
          <span className="repl-output-modal-title">
            Tutor wants to create {request.files.length} file
            {request.files.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="scaffold-modal-summary">{request.summary}</div>
        <div className="scaffold-modal-body">
          <div className="scaffold-file-list">
            {request.files.map((file) => (
              <button
                key={file.path}
                type="button"
                className={
                  file.path === selected?.path
                    ? 'scaffold-file-item scaffold-file-item-active'
                    : 'scaffold-file-item'
                }
                onClick={() => setSelectedPath(file.path)}
              >
                {file.path}
              </button>
            ))}
          </div>
          <div className="scaffold-file-preview">
            {selected !== null ? (
              <pre className="scaffold-file-content">{selected.content}</pre>
            ) : (
              <div className="repl-output-empty">No files to preview.</div>
            )}
          </div>
        </div>
        <div className="scaffold-modal-footer">
          <button
            type="button"
            className="project-btn"
            onClick={() => onRespond(request.requestId, false)}
          >
            Reject
          </button>
          <button
            type="button"
            className="review-now-btn"
            onClick={() => onRespond(request.requestId, true)}
          >
            Approve &amp; write files
          </button>
        </div>
      </div>
    </div>
  )
}
