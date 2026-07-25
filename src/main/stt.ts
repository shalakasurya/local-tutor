import { execFileSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'

const TIMEOUT_MS = 60000

function findBinary(): string | null {
  if (process.env['WHISPER_BIN'] && existsSync(process.env['WHISPER_BIN'])) {
    return process.env['WHISPER_BIN']
  }
  // Bundled static binary: packaged app Resources, or vendor/ in dev.
  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'whisper-cli')
    : join(app.getAppPath(), 'vendor', 'whisper-cli')
  if (existsSync(bundled)) return bundled
  try {
    const found = execFileSync('/usr/bin/which', ['whisper-cli'], { encoding: 'utf8' }).trim()
    if (found) return found
  } catch {
    // not found on PATH
  }
  // PATH is environment-dependent (Finder/IDE launches often lack Homebrew paths),
  // so fall back to the standard install locations directly.
  for (const candidate of ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function findModel(): string | null {
  if (process.env['WHISPER_MODEL'] && existsSync(process.env['WHISPER_MODEL'])) {
    return process.env['WHISPER_MODEL']
  }
  const candidates = [
    // Bundled with the packaged app.
    join(process.resourcesPath ?? '', 'models', 'ggml-base.en.bin'),
    join(app.getAppPath(), 'models', 'ggml-base.en.bin'),
    join(app.getPath('userData'), 'models', 'ggml-base.en.bin')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function sttStatus(): { available: boolean; reason?: string } {
  const binary = findBinary()
  if (!binary) {
    return { available: false, reason: 'whisper-cli not found — run: npm run setup:voice' }
  }
  const model = findModel()
  if (!model) {
    return { available: false, reason: 'whisper model not found — run: npm run setup:voice' }
  }
  return { available: true }
}

export async function transcribe(wav: Buffer): Promise<string> {
  const status = sttStatus()
  if (!status.available) {
    throw new Error(status.reason)
  }
  const binary = findBinary()!
  const model = findModel()!

  const startedAt = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'tutor-stt-'))
  const wavPath = join(dir, 'speech.wav')
  try {
    await writeFile(wavPath, wav)
    console.log(`[stt] transcribing ${(wav.length / 1024).toFixed(0)}KB wav`)

    const { stdout, stderr, exitCode, timedOut } = await new Promise<{
      stdout: string
      stderr: string
      exitCode: number | null
      timedOut: boolean
    }>((resolve) => {
      const child = spawn(binary, ['-m', model, '-f', wavPath, '-nt', '-np'])

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

    if (timedOut) {
      throw new Error('transcription timed out')
    }
    if (exitCode !== 0) {
      throw new Error(stderr.slice(0, 300))
    }

    console.log(`[stt] whisper finished in ${Date.now() - startedAt}ms`)
    const transcript = stdout.trim().replace(/\s+/g, ' ')
    // Whisper annotates non-speech as bracketed captions — "(bell dings)",
    // "[BLANK_AUDIO]", "(silence)". Treat those as an empty transcript so
    // background noise never becomes a message.
    if (/^[[(][^\])]*[\])]$/.test(transcript)) {
      console.log(`[stt] dropped noise annotation: ${transcript}`)
      return ''
    }
    return transcript
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
