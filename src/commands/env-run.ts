import type { EnvCommandContext } from './env'
import process from 'node:process'
import { configFileOption } from '../cli-options'
import { resolveConfig } from '../config'
import { createStorageAdapter } from '../storage/factory'
import { readStore } from '../store'
import { normalizeStoreName } from '../types'
import { applyRunResult, runProcess } from '../utils/run-process'
import { colorText } from '../utils/terminal'

const USAGE = '用法：initx env run <store> [--config <file>] [--token <token>] -- <command> [...args]'

/** Read the raw cac tail; CliOptions.string() would join and corrupt it. */
export function parseRunArgs(args: string[], tail: unknown): { name: string, command: string, args: string[] } {
  if (args.length !== 1 || !args[0])
    throw new Error(USAGE)
  const name = normalizeStoreName(args[0])
  if (!Array.isArray(tail) || !tail.every(arg => typeof arg === 'string') || !tail[0]?.trim())
    throw new Error(USAGE)
  if (tail.some(arg => arg.includes('\0')))
    throw new Error('命令或参数不能包含 NUL')
  return { name, command: tail[0], args: tail.slice(1) }
}

export function createRunEnv(
  vars: Record<string, string>,
  parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env = { ...parent }
  const names = new Set<string>()
  for (const [name, value] of Object.entries(vars)) {
    if (!/^[A-Z_]\w*$/i.test(name))
      throw new Error(`变量名 ${JSON.stringify(name)} 不合法：只允许字母、数字、下划线，不能以数字开头`)
    if (typeof value !== 'string' || value.includes('\0'))
      throw new Error(`变量 ${JSON.stringify(name)} 必须是字符串且不能包含 NUL`)
    const normalized = platform === 'win32' ? name.toUpperCase() : name
    if (names.has(normalized))
      throw new Error(`变量 ${JSON.stringify(name)} 在 Windows 上存在大小写冲突`)
    names.add(normalized)
  }
  // Collapse inherited aliases too: Node otherwise chooses a key lexicographically.
  if (platform === 'win32') {
    const inherited = new Set<string>()
    for (const key of Object.keys(env)) {
      const normalized = key.toUpperCase()
      if (names.has(normalized) || inherited.has(normalized))
        delete env[key]
      else
        inherited.add(normalized)
    }
  }
  return { ...env, ...vars }
}

export async function handleEnvRun(ctx: EnvCommandContext, args: string[]): Promise<void> {
  // Report only our own diagnostics. Upstream errors may contain response bodies,
  // token-bearing URLs, store values or the complete command arguments.
  let stage = '参数'
  try {
    const parsed = parseRunArgs(args, ctx.options.raw['--'])
    const allowed = new Set(['--', 'token', 'config'])
    if (Object.keys(ctx.options.raw).some(key => !allowed.has(key)))
      throw new Error('run 只支持 --token / --config；子进程参数必须放在 -- 后')
    const token = ctx.options.raw.token
    if (token !== undefined && typeof token !== 'string' && typeof token !== 'number')
      throw new Error('--token 需要单个值')
    const configFile = ctx.options.raw.config
    if (configFile !== undefined && (typeof configFile !== 'string' || !configFile))
      throw new Error('--config 需要单个文件路径')

    stage = '配置'
    const config = resolveConfig(ctx.store, { token: ctx.options.string('token'), config: configFileOption(ctx.options) })
    stage = '读取 store'
    const client = createStorageAdapter(config)
    const ref = await readStore(client, config.path, parsed.name)
    if (!ref)
      throw new Error('store 不存在')
    stage = '变量校验'
    const env = createRunEnv(ref.store.vars)
    stage = '启动子进程'
    const result = await runProcess(parsed.command, parsed.args, env)
    if (result.errorCode)
      process.stderr.write(`${colorText(`env run: 启动失败（${result.errorCode}）`, 'red', 'stderr')}\n`)
    applyRunResult(result)
  }
  catch (error) {
    const detail = stage === '变量校验' || stage === '参数' ? `：${(error as Error).message}` : ''
    process.stderr.write(`${colorText(`env run: ${stage}失败${detail}`, 'red', 'stderr')}\n`)
    process.exitCode = 1
  }
}
