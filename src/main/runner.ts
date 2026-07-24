import { spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { build, transform } from 'esbuild'
import type { ExerciseTest, RunResult, TestRunResult } from '../shared/types'

const MAX_OUTPUT_CHARS = 20000
const TIMEOUT_MS = 5000
const TESTS_TIMEOUT_MS = 15000
const PER_TEST_TIMEOUT_MS = 2000
const TEST_LINE = '__TUTOR_TEST__'

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(0, MAX_OUTPUT_CHARS) + '…[truncated]'
}

const CONSOLE_CAPTURE_SCRIPT = `<script>
(function () {
  var send = function (level, args) {
    var text = args.map(function (a) {
      if (typeof a === 'string') return a
      try { return JSON.stringify(a) } catch (e) { return String(a) }
    }).join(' ')
    parent.postMessage({ __tutorConsole: true, level: level, text: text }, '*')
  };
  ['log', 'info', 'warn', 'error'].forEach(function (l) {
    var orig = console[l].bind(console)
    console[l] = function () { send(l, Array.prototype.slice.call(arguments)); orig.apply(null, arguments) }
  })
  window.onerror = function (msg) { send('error', [String(msg)]) }
  window.addEventListener('unhandledrejection', function (e) { send('error', [String(e.reason)]) })
})()
</script>`

function webShell(bodyContent: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>body{font-family:system-ui,sans-serif;background:#ffffff;color:#111;margin:16px}</style>' +
    '</head><body>' +
    CONSOLE_CAPTURE_SCRIPT +
    bodyContent +
    '</body></html>'
  )
}

const CSS_SAMPLE_MARKUP = `<div class="container">
  <h1>Heading</h1>
  <p>A paragraph of sample text to style.</p>
  <div class="box">Box 1</div>
  <div class="box">Box 2</div>
  <div class="box">Box 3</div>
  <button>Button</button>
  <ul>
    <li>Item one</li>
    <li>Item two</li>
    <li>Item three</li>
  </ul>
</div>`

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

async function spawnNode(code: string, timeoutMs: number): Promise<SpawnResult> {
  const dir = await mkdtemp(join(tmpdir(), 'tutor-run-'))
  const file = join(dir, 'main.mjs')
  try {
    await writeFile(file, code, 'utf8')
    return await new Promise<SpawnResult>((resolve) => {
      const child = spawn(process.execPath, [file], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, exitCode: code, timedOut })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        stderr += String(err)
        resolve({ stdout, stderr, exitCode: null, timedOut })
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function runNode(code: string): Promise<RunResult> {
  const start = Date.now()
  const { stdout, stderr, exitCode, timedOut } = await spawnNode(code, TIMEOUT_MS)
  return {
    kind: 'node',
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    exitCode,
    timedOut,
    durationMs: Date.now() - start
  }
}

/**
 * Appends a test harness after the student's code (same module scope, so
 * assertions can call the student's functions directly). Each case reports a
 * result line as it completes, so a sync infinite loop in one case still
 * preserves the results of the cases that ran before the process is killed.
 */
function buildTestHarness(studentCode: string, tests: ExerciseTest[]): string {
  const cases = tests
    .map(
      (t) =>
        `  { description: ${JSON.stringify(t.description)}, fn: async () => {\n${t.assertion}\n  } },`
    )
    .join('\n')
  return `${studentCode}

// ---- tutor test harness (appended after student code) ----
function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed')
}
function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error((message ? message + ' — ' : '') + 'expected ' + e + ', got ' + a)
}
const __tutorTests = [
${cases}
]
;(async () => {
  for (const t of __tutorTests) {
    let line
    try {
      await Promise.race([
        t.fn(),
        new Promise((_r, reject) =>
          setTimeout(() => reject(new Error('test timed out after ${PER_TEST_TIMEOUT_MS}ms')), ${PER_TEST_TIMEOUT_MS})
        )
      ])
      line = { description: t.description, passed: true }
    } catch (err) {
      line = {
        description: t.description,
        passed: false,
        message: err instanceof Error ? err.message : String(err)
      }
    }
    console.log(${JSON.stringify(TEST_LINE)} + JSON.stringify(line))
  }
})()
`
}

export async function runTests(input: {
  language: string
  code: string
  tests: ExerciseTest[]
}): Promise<TestRunResult> {
  const language = input.language.toLowerCase()
  if (language !== 'javascript' && language !== 'typescript') {
    return {
      kind: 'tests',
      results: [],
      stdout: '',
      stderr: '',
      timedOut: false,
      buildError: `Tests are only supported for javascript/typescript exercises (got ${input.language}).`
    }
  }

  let studentCode = input.code
  if (language === 'typescript') {
    try {
      studentCode = (await transform(input.code, { loader: 'ts', format: 'esm' })).code
    } catch (err) {
      return {
        kind: 'tests',
        results: [],
        stdout: '',
        stderr: '',
        timedOut: false,
        buildError: formatBuildError(err)
      }
    }
  }

  const harness = buildTestHarness(studentCode, input.tests)
  const { stdout, stderr, timedOut } = await spawnNode(harness, TESTS_TIMEOUT_MS)

  const results: TestRunResult['results'] = []
  const studentLines: string[] = []
  for (const line of stdout.split('\n')) {
    if (line.startsWith(TEST_LINE)) {
      try {
        results.push(JSON.parse(line.slice(TEST_LINE.length)) as TestRunResult['results'][number])
      } catch {
        studentLines.push(line)
      }
    } else if (line.length > 0) {
      studentLines.push(line)
    }
  }

  // Cases the harness never reported: the first one hung (or the run died in it);
  // anything after it simply never got a chance.
  if (results.length < input.tests.length) {
    const firstMissing = results.length
    for (let i = firstMissing; i < input.tests.length; i++) {
      results.push({
        description: input.tests[i].description,
        passed: false,
        message:
          i === firstMissing
            ? timedOut
              ? 'timed out — possible infinite loop'
              : 'did not run (the program crashed before this test)'
            : 'did not run'
      })
    }
  }

  return {
    kind: 'tests',
    results,
    stdout: truncate(studentLines.join('\n')),
    stderr: truncate(stderr),
    timedOut
  }
}

function formatBuildError(err: unknown): string {
  const withErrors = err as { errors?: Array<{ text: string; location?: { file?: string; line?: number; column?: number } | null }> }
  if (withErrors && Array.isArray(withErrors.errors) && withErrors.errors.length > 0) {
    return withErrors.errors
      .map((e) => {
        const loc = e.location
        const where = loc ? ` (${loc.file ?? 'input'}:${loc.line}:${loc.column})` : ''
        return `${e.text}${where}`
      })
      .join('\n')
  }
  return err instanceof Error ? err.message : String(err)
}

export async function runCode(input: { language: string; code: string }): Promise<RunResult> {
  const { language, code } = input

  switch (language) {
    case 'javascript': {
      return runNode(code)
    }

    case 'typescript': {
      const transformed = await transform(code, { loader: 'ts', format: 'esm' })
      return runNode(transformed.code)
    }

    case 'jsx':
    case 'tsx': {
      try {
        const result = await build({
          stdin: {
            contents: code,
            loader: language,
            resolveDir: app.getAppPath()
          },
          bundle: true,
          write: false,
          format: 'iife',
          jsx: 'automatic',
          define: { 'process.env.NODE_ENV': '"development"' },
          logLevel: 'silent'
        })
        const js = result.outputFiles[0].text
        // The trailing checker surfaces the most common "white screen" cause in
        // the console strip: code that defines components but never renders them.
        const rootCheck = `<script>
setTimeout(function () {
  var root = document.getElementById('root')
  if (root && root.childNodes.length === 0) {
    console.info('Nothing was rendered into #root — did you call createRoot(document.getElementById("root")).render(<App />)?')
  }
}, 300)
</script>`
        const html = webShell(`<div id="root"></div><script>${js}</script>${rootCheck}`)
        return { kind: 'web', html }
      } catch (err) {
        return { kind: 'error', message: formatBuildError(err) }
      }
    }

    case 'html': {
      return { kind: 'web', html: CONSOLE_CAPTURE_SCRIPT + code }
    }

    case 'css': {
      const html = webShell(`<style>${code}</style>${CSS_SAMPLE_MARKUP}`)
      return { kind: 'web', html }
    }

    default:
      return { kind: 'error', message: `Unsupported language: ${language}` }
  }
}
