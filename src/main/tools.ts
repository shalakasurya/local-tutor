import type Anthropic from '@anthropic-ai/sdk'
import type { DbApi, LastRun, TutorEvent } from '../shared/types'
import type { ProjectsService } from './projects'

export interface ToolContext {
  sessionId: string
  db: DbApi
  emit: (event: TutorEvent) => void
  /** Most recent code run the student performed in this session, if any. */
  getLastRun: (sessionId: string) => LastRun | null
  /** Project (external-editor pair programming) operations; null before wiring. */
  projects: ProjectsService | null
}

// Client-side tools the instructor can call. Descriptions state WHEN to call
// each tool — recent Opus models trigger tools more reliably with explicit
// trigger conditions in the description.
const clientTools: Anthropic.Tool[] = [
  {
    name: 'show_on_whiteboard',
    description:
      'Render teaching material on the classroom whiteboard, visible to the student. ' +
      'Call this whenever you explain something that benefits from written material: ' +
      'code samples, outlines, definitions, step-by-step breakdowns, comparisons. ' +
      'Keep your spoken reply short and put the detail here instead.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short heading for the whiteboard content' },
        markdown: {
          type: 'string',
          description: 'Markdown content. Fenced code blocks are rendered with syntax highlighting.'
        }
      },
      required: ['markdown']
    }
  },
  {
    name: 'create_lesson_plan',
    description:
      'Persist a structured lesson plan to the student\'s course library. ' +
      'Call this once you and the student have agreed on a learning goal, after ' +
      'researching current material with web_search/web_fetch when useful.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of topics the plan covers'
        },
        content_md: {
          type: 'string',
          description: 'The full lesson plan as markdown: modules, sections, exercises, ordering'
        }
      },
      required: ['title', 'topics', 'content_md']
    }
  },
  {
    name: 'create_exercise',
    description:
      'Create a coding exercise and open it in the student\'s live editor, where they can ' +
      'run it and see the output. Call this when it is time for the student to practice ' +
      'what was just taught. Starter-code conventions by language: javascript/typescript run ' +
      'in Node (use console.log for output); jsx/tsx must be a self-contained module that ' +
      'renders into document.getElementById("root") using react-dom/client (react and ' +
      'react-dom imports are available); html must be a complete document (inline <style> ' +
      'and <script> allowed); css is injected into a page with sample markup, so prefer ' +
      'html exercises when specific markup matters.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt_md: { type: 'string', description: 'The exercise instructions as markdown' },
        language: {
          type: 'string',
          enum: ['javascript', 'typescript', 'jsx', 'tsx', 'html', 'css'],
          description: 'Language of the starter code'
        },
        starter_code: { type: 'string', description: 'Starter code the student begins from' },
        tests: {
          type: 'array',
          description:
            'Test cases (javascript/typescript exercises only — omit for other languages). ' +
            'Provide 3–6 covering the happy path plus edge cases. Assertions run AFTER the ' +
            "student's code in the same scope, so they can call the student's functions " +
            'directly. Helpers available: assert(condition, message) and assertEqual(actual, ' +
            'expected, message?) — assertEqual compares JSON-serialized values, so prefer ' +
            'primitives/arrays/plain objects. Descriptions are shown to the student; assertion ' +
            'code is hidden (you may reveal a failing assertion when they are stuck). The ' +
            'starter code must declare the function signature the tests call.',
          items: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'What this case checks, e.g. "returns [] for empty input"'
              },
              assertion: {
                type: 'string',
                description: "JS statements that throw on failure, e.g. assertEqual(sum([1,2]), 3)"
              }
            },
            required: ['description', 'assertion']
          }
        }
      },
      required: ['title', 'prompt_md', 'language', 'starter_code']
    }
  },
  {
    name: 'read_student_code',
    description:
      'Read the student\'s current code for the active exercise along with the output of ' +
      'their most recent run. Call this whenever the student says they are done, submits ' +
      'their solution for review, asks for help with their code, or reports an error — ' +
      'always look at their actual code before giving feedback on it.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'create_project',
    description:
      'Create a real project directory on the student\'s computer for building a complete ' +
      'project in their own editor (e.g. VS Code). Call ONLY after the student has explicitly ' +
      'agreed to start a project — this opens a folder picker on their screen where THEY choose ' +
      'the location (picking a folder is their consent; cancelling means they declined).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short project name, e.g. "Recipe Finder"' }
      },
      required: ['name']
    }
  },
  {
    name: 'scaffold_project_files',
    description:
      'Write starter files into the linked project directory. The student sees every file in an ' +
      'approval dialog and can reject the batch. Use for initial scaffolding or boilerplate the ' +
      'student should not have to type; prefer letting the student write the interesting code.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One sentence: what this scaffold sets up' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path relative to the project root' },
              content: { type: 'string' }
            },
            required: ['path', 'content']
          }
        }
      },
      required: ['summary', 'files']
    }
  },
  {
    name: 'list_project_files',
    description:
      'List the files in the linked project directory (build output, deps, and secrets excluded). ' +
      'Call before reading files when you need to orient yourself.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'read_project_file',
    description:
      'Read one file from the linked project. Call whenever your guidance depends on what the ' +
      'code actually says — never guess at the contents of a file you have not read.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the project root' }
      },
      required: ['path']
    }
  },
  {
    name: 'get_project_changes',
    description:
      'Get a unified diff of everything the student changed in the project since you last ' +
      'looked, then mark it reviewed. Call when the student asks for a review, mentions recent ' +
      'edits, or you were told files changed. This is how you "watch them code".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'start_interview',
    description:
      'Begin a mock interview. Call this once the student has asked for a mock interview ' +
      'and you know (or have confirmed) the type and level. From this point conduct a ' +
      'realistic interview per your instructions, until you call complete_interview.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['behavioral', 'coding', 'frontend_concepts', 'system_design']
        },
        level: { type: 'string', enum: ['junior', 'mid', 'senior'] },
        focus: {
          type: 'string',
          description: 'Optional focus area, e.g. "React", "CSS layout", "a startup-style loop"'
        }
      },
      required: ['kind', 'level']
    }
  },
  {
    name: 'complete_interview',
    description:
      'End the current mock interview and persist the scored report. Call this when all ' +
      'questions are done OR the student asks to stop early. Score honestly — inflated ' +
      'scores make the report useless for tracking improvement.',
    input_schema: {
      type: 'object',
      properties: {
        overall_score: { type: 'integer', description: '0–100 overall performance' },
        scores: {
          type: 'array',
          description: '3–5 dimensions appropriate to the interview type',
          items: {
            type: 'object',
            properties: {
              dimension: { type: 'string', description: 'e.g. "Communication", "Problem solving", "Code quality"' },
              score: { type: 'integer', description: '0–10' },
              comment: { type: 'string', description: 'One or two sentences of justification' }
            },
            required: ['dimension', 'score', 'comment']
          }
        },
        report_md: {
          type: 'string',
          description:
            'The full report as markdown: summary; per-question notes including what a strong ' +
            'answer looks like; top strengths; top 3 improvements; suggested practice topics.'
        }
      },
      required: ['overall_score', 'scores', 'report_md']
    }
  },
  {
    name: 'record_progress',
    description:
      'Record what you learned about the student\'s mastery of a topic. ' +
      'Call this whenever the student demonstrates understanding, struggles with a concept, ' +
      'or completes an exercise — these notes drive future review sessions.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'e.g. "React useEffect", "CSS flexbox", "binary search"' },
        mastery: { type: 'string', enum: ['struggling', 'learning', 'solid'] },
        note: { type: 'string', description: 'One or two sentences of concrete observation' }
      },
      required: ['topic', 'mastery', 'note']
    }
  }
]

// Server-side tools (run on Anthropic's infrastructure — no local execution).
// Used for pulling current tutorials/docs when building lesson plans.
const serverTools = [
  { type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: 8 },
  { type: 'web_fetch_20260209' as const, name: 'web_fetch' as const, max_uses: 8 }
]

export const allTools: Anthropic.Messages.ToolUnion[] = [...clientTools, ...serverTools]

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<string> {
  const args = (input ?? {}) as Record<string, unknown>

  switch (name) {
    case 'show_on_whiteboard': {
      const markdown = String(args.markdown ?? '')
      const title = args.title != null ? String(args.title) : null
      ctx.db.addWhiteboard({ sessionId: ctx.sessionId, title, markdown })
      ctx.emit({
        type: 'whiteboard',
        sessionId: ctx.sessionId,
        markdown,
        title: title ?? undefined
      })
      return 'Rendered on the whiteboard. The student can now see it.'
    }

    case 'create_lesson_plan': {
      const lesson = ctx.db.createLesson({
        sessionId: ctx.sessionId,
        title: String(args.title ?? 'Untitled lesson'),
        topics: Array.isArray(args.topics) ? args.topics.map(String) : [],
        contentMd: String(args.content_md ?? '')
      })
      ctx.db.addWhiteboard({
        sessionId: ctx.sessionId,
        title: `Lesson plan: ${lesson.title}`,
        markdown: lesson.contentMd
      })
      ctx.emit({
        type: 'whiteboard',
        sessionId: ctx.sessionId,
        markdown: lesson.contentMd,
        title: `Lesson plan: ${lesson.title}`
      })
      return `Lesson plan saved (id ${lesson.id}) and shown on the whiteboard.`
    }

    case 'create_exercise': {
      const exercise = ctx.db.createExercise({
        lessonId: null,
        sessionId: ctx.sessionId,
        title: String(args.title ?? 'Untitled exercise'),
        promptMd: String(args.prompt_md ?? ''),
        language: String(args.language ?? 'javascript'),
        starterCode: String(args.starter_code ?? ''),
        tests: Array.isArray(args.tests)
          ? (args.tests as Array<Record<string, unknown>>).map((t) => ({
              description: String(t.description ?? ''),
              assertion: String(t.assertion ?? '')
            }))
          : []
      })
      ctx.emit({ type: 'exercise', sessionId: ctx.sessionId, exercise })
      return `Exercise "${exercise.title}" (id ${exercise.id}) is now open in the student's editor pane.`
    }

    case 'read_student_code': {
      const lastRun = ctx.getLastRun(ctx.sessionId)
      if (!lastRun) {
        return 'The student has not run any code yet in this session.'
      }
      const exercise = ctx.db.getExercise(lastRun.exerciseId)
      const header = exercise
        ? `Exercise: "${exercise.title}" (language: ${exercise.language})`
        : `Exercise id: ${lastRun.exerciseId}`
      return [
        header,
        `Last run at: ${lastRun.at}`,
        '',
        '--- Student code ---',
        lastRun.code,
        '',
        '--- Run output ---',
        lastRun.output || '(no output)'
      ].join('\n')
    }

    case 'create_project': {
      if (!ctx.projects) throw new Error('Projects are not available')
      const project = await ctx.projects.createViaPicker(
        String(args.name ?? 'Project'),
        ctx.sessionId
      )
      if (!project) {
        return 'The student cancelled the folder picker — they declined creating the project (or want a different moment). Do not retry unless they ask again.'
      }
      return `Project "${project.name}" created at ${project.path} and linked to this session. You can now scaffold starter files (with their approval) and follow their edits.`
    }

    case 'scaffold_project_files': {
      if (!ctx.projects) throw new Error('Projects are not available')
      const project = ctx.projects.linkedProject(ctx.sessionId)
      if (!project) return 'No project is linked to this session — create or attach one first.'
      const files = Array.isArray(args.files)
        ? (args.files as Array<Record<string, unknown>>).map((f) => ({
            path: String(f.path ?? ''),
            content: String(f.content ?? '')
          }))
        : []
      if (files.length === 0) return 'No files were provided.'
      const approved = await ctx.projects.scaffold(
        ctx.sessionId,
        project,
        String(args.summary ?? ''),
        files
      )
      return approved
        ? `Scaffolded ${files.length} file(s) into ${project.name}. Walk the student through what each file does.`
        : 'The student declined (or did not respond to) the scaffold request — ask what they would prefer.'
    }

    case 'list_project_files': {
      if (!ctx.projects) throw new Error('Projects are not available')
      const project = ctx.projects.linkedProject(ctx.sessionId)
      if (!project) return 'No project is linked to this session.'
      const files = await ctx.projects.projectFiles(project)
      return files.length > 0 ? files.join('\n') : '(project is empty)'
    }

    case 'read_project_file': {
      if (!ctx.projects) throw new Error('Projects are not available')
      const project = ctx.projects.linkedProject(ctx.sessionId)
      if (!project) return 'No project is linked to this session.'
      return ctx.projects.readProjectFile(project, String(args.path ?? ''))
    }

    case 'get_project_changes': {
      if (!ctx.projects) throw new Error('Projects are not available')
      const project = ctx.projects.linkedProject(ctx.sessionId)
      if (!project) return 'No project is linked to this session.'
      const diff = await ctx.projects.reviewChanges(project)
      return diff.length > 0 ? diff : 'No changes since you last looked.'
    }

    case 'start_interview': {
      // Any stale in-progress interview in this session is superseded.
      ctx.db.abandonActiveInterviews(ctx.sessionId)
      const interview = ctx.db.createInterview({
        sessionId: ctx.sessionId,
        kind: String(args.kind ?? 'behavioral'),
        level: String(args.level ?? 'mid')
      })
      ctx.emit({ type: 'interview-started', sessionId: ctx.sessionId, interview })
      return (
        `Interview started (${interview.kind}, ${interview.level}` +
        (args.focus ? `, focus: ${String(args.focus)}` : '') +
        '). You are now the interviewer — begin with a brief realistic introduction and your first question.'
      )
    }

    case 'complete_interview': {
      const active = ctx.db.getActiveInterview(ctx.sessionId)
      if (!active) {
        return 'No interview is in progress in this session — nothing to complete.'
      }
      const scores = Array.isArray(args.scores)
        ? (args.scores as Array<Record<string, unknown>>).map((s) => ({
            dimension: String(s.dimension ?? ''),
            score: Math.max(0, Math.min(10, Number(s.score ?? 0))),
            comment: String(s.comment ?? '')
          }))
        : []
      const overallScore = Math.max(0, Math.min(100, Number(args.overall_score ?? 0)))
      ctx.db.completeInterview(active.id, {
        overallScore,
        scores,
        reportMd: String(args.report_md ?? '')
      })
      const completed: typeof active = {
        ...active,
        status: 'completed',
        completedAt: new Date().toISOString(),
        overallScore,
        scores,
        reportMd: String(args.report_md ?? '')
      }
      ctx.emit({ type: 'interview-completed', sessionId: ctx.sessionId, interview: completed })
      return `Interview report saved (overall ${overallScore}/100). The student can now see it in the Interviews tab — debrief verbally as their tutor.`
    }

    case 'record_progress': {
      const mastery = String(args.mastery ?? 'learning') as 'struggling' | 'learning' | 'solid'
      ctx.db.addProgressNote({
        topic: String(args.topic ?? 'general'),
        mastery,
        note: String(args.note ?? '')
      })
      return 'Progress recorded.'
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
