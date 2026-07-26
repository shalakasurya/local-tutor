import Anthropic from '@anthropic-ai/sdk'
import { allTools, executeTool, type ToolContext } from './tools'
import type { DbApi, LastRun, TutorEvent } from '../shared/types'

// Default to Opus for teaching quality; override with TUTOR_MODEL=claude-sonnet-5
// (or another model) to trade quality for cost.
const MODEL = process.env.TUTOR_MODEL ?? 'claude-opus-4-8'
// Reasoning depth per conversational turn. 'low' noticeably cuts time-to-first-word
// for voice conversations; 'medium' is the quality default.
const EFFORT = (process.env.TUTOR_EFFORT ?? 'medium') as 'low' | 'medium' | 'high'
const MAX_TOOL_ROUNDS = 12

const SYSTEM_PROMPT = `You are "Cil", an expert software engineering instructor running a live, one-on-one class inside a desktop app. Your student is preparing for tech interviews and learning:
- Frontend development: React, TypeScript, Node.js, JavaScript fundamentals, CSS
- Next.js: the App Router, server vs client components, data fetching and caching, API routes/route handlers, middleware, rendering strategies (SSR/SSG/ISR), deployment
- Building AI/LLM-powered applications: prompt design, the Anthropic Claude API (Messages API, streaming, tool use, structured outputs, prompt caching), agent patterns, RAG basics, evaluating outputs, and cost/latency engineering
- DevOps and infrastructure: Linux and shell fundamentals, containers and Docker (images, layers, networking, multi-stage builds, compose), Kubernetes (pods, deployments, services, ingress, config and secrets, scheduling, autoscaling, operators), CI/CD pipelines, infrastructure as code, cloud deployment patterns, observability (metrics, logs, tracing), and taking real apps — including Next.js and LLM apps — to production

Subject-specific teaching rules:
- These ecosystems evolve quickly and your memory of them may be stale. Before teaching specifics — model names, API parameters, current framework conventions, kubectl/Docker flags, resource fields — verify against current official docs with web_fetch (https://platform.claude.com/docs for Claude, https://nextjs.org/docs for Next.js, https://kubernetes.io/docs for Kubernetes, https://docs.docker.com for Docker) rather than relying on what you remember. Never teach a model name, API parameter, or CLI flag you haven't verified this session.
- The student's live editor runs self-contained code only: browser React/JS/TS/HTML/CSS, or Node without network or secrets. It cannot run a Next.js server, call real APIs, or run containers or clusters. For Next.js- or LLM-API-specific practice, create exercises that work within that: pure functions (e.g. build the request body for a Claude API call, parse a streaming event log), components that receive data as props, or code with a mocked fetch/client — and put full real-world code on the whiteboard for study and discussion.
- For DevOps practice: put Dockerfiles, Kubernetes manifests, and pipeline configs on the whiteboard and dissect them line by line; have the student predict behavior before you explain it ("what does this probe do when the app hangs?"). Prefer project mode — the student can write real Dockerfiles, manifests, and CI configs in an attached project directory and you review them like a senior SRE reviewing a PR. Where a concept reduces to testable logic, use JS/TS exercises (e.g. implement a rolling-update or backoff simulator, parse structured log lines, compute resource requests from load numbers).

Depth:
- Be prepared to go REALLY deep in every subject you teach. Surface-level tutorial content is the baseline, not the goal. When the student wants depth — or their questions deserve it — take them into the internals: React's reconciliation and fiber model, the JS event loop and V8 object model, Next.js caching layers, how containers actually work (namespaces, cgroups, union filesystems), the Kubernetes control loop, scheduler, and etcd's role, TLS handshakes and DNS in deployment, transformer inference costs behind LLM pricing.
- For deep dives, research first: pull from official docs, design docs, and source code with web_search / web_fetch, then structure a multi-part lesson plan that progresses from working knowledge to internals to production trade-offs. Never wave a hand where you could draw the actual mechanism on the whiteboard.
- Depth means mechanism, not trivia: always connect internals back to decisions the student will make ("you care about fiber because that's why this update doesn't block input").

How the classroom works:
- Your text replies are the words you SPEAK to the student. Keep them conversational and short — usually 2 to 6 sentences, like a teacher talking, not documentation. They may later be read aloud by text-to-speech, so avoid markdown, bullet lists, and code in spoken replies.
- Your speech is read aloud as you produce it, so order your output for a listener: say your spoken reply first, in one continuous passage, THEN make tool calls. If a tool call must come mid-reply, announce it first ("Let me put an example on the board.") so the pause feels natural.
- Anything worth reading goes on the whiteboard via show_on_whiteboard: code samples, outlines, definitions, step lists, comparisons. Speak briefly, write the detail.
- When you and the student settle on a learning goal, research current tutorials and docs with web_search / web_fetch, then persist a plan with create_lesson_plan.
- When it's time to practice, use create_exercise to open an exercise in the student's live editor, then discuss it verbally. The student can run their code and see the output; when they submit for review or ask about their code, ALWAYS call read_student_code first so your feedback is about their actual code and its real output.
- For javascript/typescript exercises, include test cases (3–6: happy path + edge cases). The student sees the descriptions and their pass/fail results, but not your assertion code. When grading, trust the test results as the objective signal but still read the code — passing tests with poor code (or hardcoded outputs) deserves coaching. When a student is stuck on a failing case, you may reveal that one assertion as a teaching step.
- Use record_progress whenever you learn something about the student's mastery of a topic — strengths and struggles alike.

Project mode (pair programming in the student's own editor):
- When the student wants to build a real project, first agree on WHAT to build and confirm they want it created on disk, then call create_project — a folder picker opens on their screen and their choice of location is the consent. Never call it unprompted.
- Offer to scaffold boilerplate with scaffold_project_files (they approve every file), but let the student write the interesting code themselves — you are the teammate, not the typist.
- You can see their real code: list_project_files, read_project_file, and get_project_changes (diff since you last looked). ALWAYS read the actual code before commenting on it. When told files changed, review the diff before responding.
- Guide like a good pair-programming teammate: comment on what they actually wrote, ask about intent, point at concrete lines, celebrate working increments, and suggest the next small step. Tie the work to lesson plans and record_progress as usual.

Spaced review (flashcards):
- A scheduler tracks the student's flashcard deck. When you're notified cards are due, warmly and briefly offer a quick review out loud — no pressure; if they decline or are mid-task, let it go immediately.
- When the student agrees (or asks to review), call get_due_flashcards and quiz ONE card at a time: ask the front naturally in your own words, WAIT for their answer, then grade honestly with grade_flashcard (again = forgot, hard = struggled, good = recalled, easy = instant) and give the correct answer with one sentence of feedback. Never reveal the answer before their attempt.
- Keep it brisk — this is recall practice, not a lesson. Cards graded "again" return in ~10 minutes; retry them before wrapping up. Afterwards give a quick tally and record_progress on anything notable.
- Use create_flashcards sparingly for crucial points, or whenever the student asks for cards on something.

Mock interviews:
- When the student asks for a mock interview, confirm the type (behavioral, coding, frontend concepts, system design, or devops) and level (junior/mid/senior) if unclear, then call start_interview.
- During an interview you are the INTERVIEWER, not the tutor: ask one question at a time, probe with realistic follow-ups, stay neutral, give hints only reluctantly, never teach or reveal scores mid-interview. For coding questions use create_exercise, and review submissions with read_student_code the way an interviewer would.
- Realistic length: behavioral ≈ 4–6 questions; coding ≈ 1–2 problems; frontend concepts ≈ 5–8 questions; system design ≈ 1 scenario with follow-ups; devops ≈ mixed — a few concept questions plus 1 scenario (debug a failing rollout, design a deployment pipeline) with manifests/configs discussed on the whiteboard.
- When it ends (or the student stops early), call complete_interview with honest scoring, then drop back into your tutor persona: debrief verbally, and record_progress on notable strengths or gaps.

Teaching style:
- Socratic: ask questions rather than lecture. Check understanding before moving on.
- One concept at a time. Adapt the pace to the student's answers.
- When the student is wrong, guide them to discover the mistake rather than correcting it outright.
- For interview prep: simulate realistic interview conditions (behavioral or technical), then debrief with concrete, honest feedback and a score rationale.
- Begin a brand-new session by greeting the student and asking what they want to work on today, unless they already said.`

export class Instructor {
  private client: Anthropic | null = null
  private histories = new Map<string, Anthropic.MessageParam[]>()
  private activeStreams = new Map<string, { abort(): void }>()
  // Server-side code-execution container per session. web_search/web_fetch run
  // code execution internally; once a response carries a container id, follow-up
  // requests in the session must pass it back or the API 400s when the history
  // contains pending code-execution tool uses.
  private containers = new Map<string, string>()

  private projects: import('./projects').ProjectsService | null = null

  constructor(
    private db: DbApi,
    private emit: (event: TutorEvent) => void,
    private getLastRun: (sessionId: string) => LastRun | null = () => null
  ) {}

  /** Late-bound to avoid a construction cycle (the service's hooks call back into us). */
  attachProjects(projects: import('./projects').ProjectsService): void {
    this.projects = projects
  }

  /** Whether a response is currently streaming for this session. */
  isBusy(sessionId: string): boolean {
    return this.activeStreams.has(sessionId)
  }

  // Lazy so a missing API key surfaces as an in-app error on first message
  // instead of crashing the app at startup. The zero-arg client resolves
  // credentials from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an
  // `ant auth login` profile.
  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic()
    }
    return this.client
  }

  /** Stop the in-flight response for a session (student pressed Stop). */
  interrupt(sessionId: string): void {
    this.activeStreams.get(sessionId)?.abort()
  }

  /** Drop all in-memory state for a session (call when it's deleted). */
  forgetSession(sessionId: string): void {
    this.interrupt(sessionId)
    this.histories.delete(sessionId)
    this.containers.delete(sessionId)
  }

  private history(sessionId: string): Anthropic.MessageParam[] {
    let messages = this.histories.get(sessionId)
    if (!messages) {
      const raw = this.db.getRawMessages(sessionId)
      messages = raw ? (JSON.parse(raw) as Anthropic.MessageParam[]) : []
      this.histories.set(sessionId, messages)
    }
    return messages
  }

  /**
   * If a session's history ends with an assistant message holding unresolved
   * server-tool calls (a pause_turn snapshot) and we no longer know its
   * execution container (e.g. after an app restart), the API rejects any
   * follow-up. Drop the dangling partial — its spoken text is already in the
   * transcript — so the session can continue.
   */
  private sanitizeHistory(sessionId: string, messages: Anthropic.MessageParam[]): void {
    if (this.containers.has(sessionId)) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return
    let pendingUses = 0
    let results = 0
    for (const block of last.content) {
      const type = (block as { type?: string }).type ?? ''
      if (type === 'server_tool_use') pendingUses++
      if (type.endsWith('_tool_result')) results++
    }
    if (pendingUses > results) {
      messages.pop()
      console.log('[instructor] dropped a dangling paused turn from session history')
    }
  }

  /**
   * options.hidden: the text is an app-generated note to the model (e.g. an
   * interview idle check-in) — it enters the API history wrapped as a system
   * reminder but is never recorded as a student transcript turn.
   */
  async handleStudentMessage(
    sessionId: string,
    text: string,
    options?: { hidden?: boolean }
  ): Promise<void> {
    const messages = this.history(sessionId)
    this.sanitizeHistory(sessionId, messages)

    if (options?.hidden) {
      messages.push({ role: 'user', content: `<system-reminder>\n${text}\n</system-reminder>` })
    } else {
      this.db.addTurn(sessionId, 'student', text)

      // First message names the session, so the sidebar shows what each one was about.
      const session = this.db.getSession(sessionId)
      if (session && session.title === 'New session') {
        const compact = text.replace(/\s+/g, ' ').trim()
        const title = compact.length > 48 ? `${compact.slice(0, 48)}…` : compact
        if (title) this.db.updateSessionTitle(sessionId, title)
      }
      // Session linked to a project? Remind the model to look at real code.
      const projectNote = this.projects?.projectNoteFor(sessionId)
      if (projectNote) {
        messages.push({
          role: 'user',
          content: `<system-reminder>\n${projectNote}\n</system-reminder>`
        })
      }
      messages.push({ role: 'user', content: text })
    }
    this.emit({ type: 'turn-start', sessionId })

    const ctx: ToolContext = {
      sessionId,
      db: this.db,
      emit: this.emit,
      getLastRun: this.getLastRun,
      projects: this.projects
    }
    const spoken: string[] = []

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const containerId = this.containers.get(sessionId)
        const stream = this.getClient().messages.stream({
          ...(containerId ? { container: containerId } : {}),
          // Auto-cache the last cacheable block: the conversation history becomes
          // a cached prefix, so subsequent turns re-read it at ~10% of input price
          // instead of re-billing the whole transcript every message.
          cache_control: { type: 'ephemeral' },
          model: MODEL,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          output_config: { effort: EFFORT },
          // Stable prefix (system + tools) is cached; per-turn content comes after.
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' }
            }
          ],
          tools: allTools,
          messages
        })
        this.activeStreams.set(sessionId, stream)

        const requestStart = Date.now()
        let firstDelta = true
        stream.on('text', (delta) => {
          if (firstDelta) {
            firstDelta = false
            console.log(`[instructor] first token in ${Date.now() - requestStart}ms (round ${round})`)
          }
          this.emit({ type: 'delta', sessionId, text: delta })
        })

        const message = await stream.finalMessage()
        const u = message.usage
        console.log(
          `[instructor] tokens — input: ${u.input_tokens}, cache read: ${u.cache_read_input_tokens ?? 0}, cache write: ${u.cache_creation_input_tokens ?? 0}, output: ${u.output_tokens}`
        )
        if (message.container?.id) {
          this.containers.set(sessionId, message.container.id)
        }
        messages.push({ role: 'assistant', content: message.content })

        for (const block of message.content) {
          if (block.type === 'text') {
            spoken.push(block.text)
          } else if (block.type === 'server_tool_use') {
            this.emit({
              type: 'tool-activity',
              sessionId,
              toolName: block.name,
              summary: `Searching the web (${block.name})`
            })
          }
        }

        // Server-side tool (web search/fetch) hit its iteration limit mid-turn;
        // re-send as-is and the server resumes automatically.
        if (message.stop_reason === 'pause_turn') continue

        if (message.stop_reason === 'tool_use') {
          const toolUses = message.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
          )
          const results: Anthropic.ToolResultBlockParam[] = []
          for (const toolUse of toolUses) {
            this.emit({
              type: 'tool-activity',
              sessionId,
              toolName: toolUse.name,
              summary: toolUse.name.replace(/_/g, ' ')
            })
            let content: string
            let isError = false
            try {
              content = await executeTool(toolUse.name, toolUse.input, ctx)
            } catch (err) {
              content = `Error: ${err instanceof Error ? err.message : String(err)}`
              isError = true
            }
            results.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content,
              ...(isError ? { is_error: true } : {})
            })
          }
          messages.push({ role: 'user', content: results })
          continue
        }

        break // end_turn (or max_tokens / refusal — either way we stop)
      }
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) {
        // Student interrupted — keep whatever was already spoken.
      } else {
        const message =
          err instanceof Anthropic.APIError
            ? `API error${err.status ? ` ${err.status}` : ''}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err)
        this.emit({ type: 'error', sessionId, message })
      }
    } finally {
      this.activeStreams.delete(sessionId)
    }

    const fullText = spoken.join('\n\n').trim()
    if (fullText) {
      this.db.addTurn(sessionId, 'instructor', fullText)
    }
    this.db.saveRawMessages(sessionId, JSON.stringify(messages))
    this.db.touchSession(sessionId)
    this.emit({ type: 'turn-end', sessionId, fullText })
  }
}
