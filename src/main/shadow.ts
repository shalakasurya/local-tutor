// Shadow git repository: tracks a student's project directory in a git dir the
// app owns, WITHOUT touching the project's own .git (if it even has one). This
// gives us battle-tested snapshot/diff machinery for "what changed since the
// tutor last looked", regardless of whether the student uses git.
//
// No Electron imports — this module is pure Node so it can be unit-tested
// directly against a temp directory.

import { execFile } from 'child_process'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { ChangedFile } from '../shared/types'

export interface ShadowRepo {
  /** The app-owned git dir, e.g. <userData>/shadow/<projectId>.git */
  gitDir: string
  /** The student's project directory. */
  workTree: string
}

/** Hash of git's canonical empty tree — diff base before the first checkpoint exists. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// Never track build output, deps, or anything secret-shaped. The project's own
// .gitignore is respected too (git reads it from the work tree).
const EXCLUDES = [
  '.git/',
  'node_modules/',
  '.env',
  '.env.*',
  'dist/',
  'out/',
  'build/',
  '.next/',
  'coverage/',
  '*.log',
  '.DS_Store',
  'models/',
  '*.pem',
  '*.key',
  'id_rsa*',
  '*secret*',
  '*credential*'
].join('\n')

function git(
  repo: ShadowRepo,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: repo.workTree,
        env: {
          ...process.env,
          GIT_DIR: repo.gitDir,
          GIT_WORK_TREE: repo.workTree,
          GIT_AUTHOR_NAME: 'Local Tutor',
          GIT_AUTHOR_EMAIL: 'tutor@local',
          GIT_COMMITTER_NAME: 'Local Tutor',
          GIT_COMMITTER_EMAIL: 'tutor@local'
        },
        maxBuffer: 16 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0
        resolve({ stdout: String(stdout), stderr: String(stderr), code })
      }
    )
  })
}

export async function initShadow(repo: ShadowRepo): Promise<void> {
  await mkdir(repo.gitDir, { recursive: true })
  const res = await git(repo, ['init'])
  if (res.code !== 0) {
    throw new Error(`shadow git init failed: ${res.stderr.slice(0, 300)}`)
  }
  await mkdir(join(repo.gitDir, 'info'), { recursive: true })
  await writeFile(join(repo.gitDir, 'info', 'exclude'), EXCLUDES + '\n')
}

async function hasHead(repo: ShadowRepo): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', 'HEAD'])).code === 0
}

/** Commit the current tree state. Returns false when there was nothing to commit. */
export async function checkpoint(repo: ShadowRepo, message: string): Promise<boolean> {
  await git(repo, ['add', '-A'])
  const staged = await git(repo, ['diff', '--cached', '--quiet'])
  if (staged.code === 0 && (await hasHead(repo))) {
    return false // nothing staged and not the first commit
  }
  const res = await git(repo, ['commit', '-m', message, '--allow-empty'])
  if (res.code !== 0) {
    throw new Error(`shadow checkpoint failed: ${res.stderr.slice(0, 300)}`)
  }
  return true
}

/** Files changed (incl. untracked) since the last checkpoint. */
export async function changedFiles(repo: ShadowRepo): Promise<ChangedFile[]> {
  const res = await git(repo, ['status', '--porcelain'])
  return res.stdout
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3).replace(/^"|"$/g, '') }))
}

/** Project file listing (tracked + untracked, excludes applied), capped. */
export async function listFiles(repo: ShadowRepo, max = 400): Promise<string[]> {
  const res = await git(repo, ['ls-files', '-co', '--exclude-standard'])
  const files = res.stdout.split('\n').filter((f) => f.length > 0)
  if (files.length > max) {
    return [...files.slice(0, max), `…and ${files.length - max} more files`]
  }
  return files
}

/**
 * Unified diff of everything since the last checkpoint (untracked files included
 * via intent-to-add). Truncated to maxBytes with a marker.
 */
export async function diffSinceCheckpoint(repo: ShadowRepo, maxBytes: number): Promise<string> {
  // Intent-to-add makes untracked files visible to `diff HEAD` without staging content.
  await git(repo, ['add', '-A', '--intent-to-add'])
  const base = (await hasHead(repo)) ? 'HEAD' : EMPTY_TREE
  const stat = await git(repo, ['diff', base, '--stat'])
  const patch = await git(repo, ['diff', base])
  let text = stat.stdout + '\n' + patch.stdout
  if (Buffer.byteLength(text) > maxBytes) {
    text = text.slice(0, maxBytes) + '\n…[diff truncated — read specific files for the rest]'
  }
  return text.trim()
}
