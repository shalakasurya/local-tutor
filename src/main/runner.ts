import { spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { build, transform } from 'esbuild'
import type { RunResult } from '../shared/types'

const MAX_OUTPUT_CHARS = 20000
const TIMEOUT_MS = 5000

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

async function runNode(code: string): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), 'tutor-run-'))
  const file = join(dir, 'main.mjs')
  const start = Date.now()
  try {
    await writeFile(file, code, 'utf8')

    const { stdout, stderr, exitCode, timedOut } = await new Promise<{
      stdout: string
      stderr: string
      exitCode: number | null
      timedOut: boolean
    }>((resolve) => {
      const child = spawn(process.execPath, [file], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, TIMEOUT_MS)

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

    return {
      kind: 'node',
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      exitCode,
      timedOut,
      durationMs: Date.now() - start
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
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
