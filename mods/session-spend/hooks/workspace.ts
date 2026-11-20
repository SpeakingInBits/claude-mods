// The repository and branch the session works in, for the card's top line.

import type { EngineInterface } from 'claude-code'

import type { Workspace } from '../types'

/** The repository's name: the remote's last path segment, else the root folder's. */
export const repoName = (remote: string | null, root: string): string => {
  const fromRemote = remote
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .at(-1)
  const folder = root.replaceAll('\\', '/').replace(/\/+$/, '').split('/').at(-1)
  return fromRemote || folder || root
}

async function git($: EngineInterface, args: string[]): Promise<string> {
  const ran = await $.process.run(['git', ...args], { timeoutMs: 5000 })
  return ran.exitCode === 0 ? ran.stdout.trim() : ''
}

/** Reads the repository and branch now; `none` outside a git repository. */
export async function readWorkspace($: EngineInterface): Promise<Workspace | 'none'> {
  const repo = await $.session.repo()
  if (repo === null) return 'none'
  const name = repoName(repo.remote, repo.root)
  const branch = await git($, ['branch', '--show-current'])
  if (branch !== '') return { repo: name, branch, isDetached: false }
  const sha = await git($, ['rev-parse', '--short', 'HEAD'])
  return { repo: name, branch: sha, isDetached: sha !== '' }
}

export const sameWorkspace = (
  a: Workspace | 'none' | null,
  b: Workspace | 'none' | null,
): boolean => JSON.stringify(a) === JSON.stringify(b)
