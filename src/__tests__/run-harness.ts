import type { ChildProcess } from 'node:child_process'
import type { EnvPluginStore } from '../config'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

export const root = resolve(import.meta.dirname, '../..')
export const fixtures = join(import.meta.dirname, 'fixtures')

/**
 * 子进程夹具走真实插件入口时，需要一份可用的 profile。
 *
 * 重构后本地配置只能来自 profile，`INITX_ENV_REPO` 之类的环境变量覆盖已经取消，
 * 所以这里把 HOME 指到临时目录并写入一份 GitHub profile。
 */
const HARNESS_PROFILE = {
  defaultProfile: 'default',
  profiles: {
    default: {
      type: 'github',
      apiBaseUrl: 'https://api.github.com',
      repo: 'fake/vault',
      branch: 'test-branch',
      path: 'test-stores',
      token: 'fake-bootstrap-token'
    },
    // 不同用例会写不同的项目定位，这里预先备好对应的 profile，
    // 让每个用例只关心自己要验证的行为。
    gitlabExample: {
      type: 'gitlab',
      apiBaseUrl: 'https://gitlab.example/api/v4',
      repo: 'fake/vault',
      branch: 'test-branch',
      path: 'test-stores',
      token: 'fake-bootstrap-token'
    },
    gitlabGroup: {
      type: 'gitlab',
      apiBaseUrl: 'https://gitlab.com/api/v4',
      repo: 'group/vault',
      branch: 'main',
      path: 'stores',
      token: 'fake-bootstrap-token'
    },
    gitlabSub: {
      type: 'gitlab',
      apiBaseUrl: 'https://gitlab.example/api/v4',
      repo: 'group/sub/vault',
      branch: 'test-branch',
      path: 'test-stores',
      token: 'fake-bootstrap-token'
    },
    githubGroup: {
      type: 'github',
      apiBaseUrl: 'https://api.github.com',
      repo: 'group/vault',
      branch: 'main',
      path: 'stores',
      token: 'fake-bootstrap-token'
    }
  }
}

export async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'initx-env-run-'))
  const home = join(directory, 'home')
  await mkdir(join(home, '.initx', 'stores', '@initx-plugin', 'env'), { recursive: true })

  await writeFile(
    join(home, '.initx', 'stores', '@initx-plugin', 'env', 'store.json'),
    JSON.stringify(HARNESS_PROFILE, null, 2)
  )

  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(?:INITX_ENV_|GH_TOKEN$|GITHUB_TOKEN$|NODE_OPTIONS$)/i.test(key))
      delete env[key]
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    INITX_ENV_TOKEN: 'fake-bootstrap-token',
    INITX_TEST_EVENTS: join(directory, 'events.jsonl'),
    GITHUB_ENV: join(directory, 'github-env')
  })
  await writeFile(env.GITHUB_ENV!, 'unchanged\n')

  return {
    directory,
    home,
    env,
    /** 需要直接调用 handler 时用的 store：带一份可用的默认 profile */
    testStore: () => structuredClone(HARNESS_PROFILE) as EnvPluginStore,
    /** 写到 harness 临时目录里的项目文件，供需要项目定位的用例使用 */
    async project(body: unknown) {
      const file = join(directory, '.initx-env.json')
      await writeFile(file, JSON.stringify(body))
      return file
    },
    async cleanup() {
      // Delete only the absolute directory returned by mkdtemp, never its parent.
      if (dirname(directory) !== resolve(tmpdir()) || !directory.startsWith(join(resolve(tmpdir()), 'initx-env-run-')))
        throw new Error('Unsafe test cleanup path')
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      })
    }
  }
}

export function start(command: string, args: string[], options: { env: NodeJS.ProcessEnv, cwd: string }, ipc = false) {
  const child = spawn(command, args, {
    ...options,
    stdio: ipc
      ? ['pipe', 'pipe', 'pipe', 'ipc']
      : 'pipe'
  })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => stdout += chunk)
  child.stderr!.on('data', chunk => stderr += chunk)
  const done = new Promise<{ code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return {
    child,
    done,
    output: () => ({ stdout, stderr })
  }
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
