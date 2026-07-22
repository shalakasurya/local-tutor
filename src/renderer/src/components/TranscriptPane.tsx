import { useEffect, useRef } from 'react'
import type { TranscriptTurn } from '../../../shared/types'

interface TranscriptPaneProps {
  turns: TranscriptTurn[]
  streaming: boolean
  streamText: string
  activity: string | null
  /** Called when a turn is clicked — used to navigate the whiteboard to that point in time. */
  onTurnClick: (turn: TranscriptTurn) => void
}

export default function TranscriptPane({
  turns,
  streaming,
  streamText,
  activity,
  onTurnClick
}: TranscriptPaneProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [turns, streamText, streaming, activity])

  return (
    <div className="transcript" ref={scrollRef}>
      {turns.length === 0 && !streaming && (
        <div className="transcript-empty">
          Say hello to your instructor to start the lesson.
        </div>
      )}

      {turns.map((turn) => (
        <div
          key={turn.id}
          className={turn.role === 'student' ? 'turn-row turn-row-student' : 'turn-row turn-row-instructor'}
        >
          <div
            className={
              (turn.role === 'student' ? 'bubble bubble-student' : 'bubble bubble-instructor') +
              ' bubble-clickable'
            }
            title="Show the whiteboard as of this message"
            onClick={() => {
              // Don't hijack text selection — only navigate on a plain click.
              if (window.getSelection()?.toString()) return
              onTurnClick(turn)
            }}
          >
            {turn.content}
          </div>
        </div>
      ))}

      {streaming && (
        <div className="turn-row turn-row-instructor">
          <div className="bubble bubble-instructor bubble-streaming">
            {streamText}
            <span className="speaking-indicator">speaking…</span>
          </div>
        </div>
      )}

      {activity !== null && <div className="tool-activity">⚙ {activity}</div>}
    </div>
  )
}
