import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

export const root = resolve(import.meta.dirname, '../..')
export const fixtures = join(import.meta.dirname, 'fixtures')

export async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'initx-env-run-'))
  const home = join(directory, 'home')
  await mkdir(home)

  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(?:INITX_ENV_|GH_TOKEN$|GITHUB_TOKEN$|NODE_OPTIONS$)/i.test(key))
      delete env[key]
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    INITX_ENV_REPO: 'fake/vault',
    INITX_ENV_TOKEN: 'fake-bootstrap-token',
    INITX_ENV_BRANCH: 'test-branch',
    INITX_ENV_PATH: 'test-stores',
    INITX_TEST_EVENTS: join(directory, 'events.jsonl'),
    GITHUB_ENV: join(directory, 'github-env')
  })
  await writeFile(env.GITHUB_ENV!, 'unchanged\n')

  return {
    directory,
    env,
    async cleanup() {
      // Delete only the absolute directory returned by mkdtemp, never its parent.
      if (dirname(directory) !== resolve(tmpdir()) || !directory.startsWith(join(resolve(tmpdir()), 'initx-env-run-')))
        throw new Error('Unsafe test cleanup path')
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}

export function start(command: string, args: string[], options: { env: NodeJS.ProcessEnv, cwd: string }, ipc = false) {
  const child = spawn(command, args, { ...options, stdio: ipc ? ['pipe', 'pipe', 'pipe', 'ipc'] : 'pipe' })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => stdout += chunk)
  child.stderr!.on('data', chunk => stderr += chunk)
  const done = new Promise<{ code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { child, done, output: () => ({ stdout, stderr }) }
}

export async function waitForOutput(running: ReturnType<typeof start>, text: string): Promise<void> {
  const deadline = Date.now() + 15000
  while (!running.output().stdout.includes(text)) {
    if (running.child.exitCode !== null || running.child.signalCode !== null || Date.now() > deadline)
      throw new Error(`Fixture did not reach ${text}: ${JSON.stringify(running.output())}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

export function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL')
}
