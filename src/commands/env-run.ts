import type { ResolvedEnvConfig } from '../config'
import type { EnvCommandContext } from './env'
import process from 'node:process'
import { logger } from '@initx-plugin/utils'
import { configFileOption } from '../cli-options'
import { ProfileError, resolveConfig } from '../config'
import { MAX_ENV_BYTES, oversizedValues } from '../files/limits'
import { FileRefError } from '../files/refs'
import { resolveStoreVars } from '../files/resolve'
import { StorageError } from '../storage/errors'
import { createStorageAdapter } from '../storage/factory'
import { readStore, StoreReadError } from '../store'
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

/**
 * 报错时用于说明“卡在哪一步”。
 *
 * 用英文枚举做判断，避免中文字面量散落在控制流里；
 * 面向用户的措辞集中在 STAGE_LABELS，改文案不影响比较逻辑。
 */
type RunStage = 'args' | 'config' | 'store' | 'vars' | 'spawn'

const STAGE_LABELS: Record<RunStage, string> = {
  args: '参数',
  config: '配置',
  store: '读取 store',
  vars: '变量校验',
  spawn: '启动子进程'
}

export async function handleEnvRun(ctx: EnvCommandContext, args: string[]): Promise<void> {
  // Report only our own diagnostics. Upstream errors may contain response bodies,
  // token-bearing URLs, store values or the complete command arguments.
  let stage: RunStage = 'args'
  let config: ResolvedEnvConfig | undefined
  try {
    const parsed = parseRunArgs(args, ctx.options.raw['--'])
    const allowed = new Set(['--', 'token', 'config', 'debug', 'd'])
    if (Object.keys(ctx.options.raw).some(key => !allowed.has(key)))
      throw new Error('run 只支持 --token / --config 和全局 --debug / -d；子进程参数必须放在 -- 后')
    const token = ctx.options.raw.token
    if (token !== undefined && typeof token !== 'string' && typeof token !== 'number')
      throw new Error('--token 需要单个值')
    const configFile = ctx.options.raw.config
    if (configFile !== undefined && (typeof configFile !== 'string' || !configFile))
      throw new Error('--config 需要单个文件路径')

    stage = 'config'
    config = resolveConfig(ctx.store, {
      token: ctx.options.string('token'),
      project: ctx.project,
      config: ctx.project === undefined ? configFileOption(ctx.options) : undefined
    })
    stage = 'store'
    const client = createStorageAdapter({ ...config, debug: ctx.options.boolean('debug') || ctx.options.boolean('d') })
    const ref = await readStore(client, config.path, parsed.name)
    if (!ref)
      throw new StoreReadError('not-found')
    stage = 'vars'
    const resolved = await resolveStoreVars(client, config.path, parsed.name, ref.store)
    for (const item of oversizedValues(resolved.vars, MAX_ENV_BYTES))
      logger.warn(colorText(`env run: ${item.key} 有 ${item.bytes} 字节，超过 ${MAX_ENV_BYTES} 字节建议上限；大文件请用 initx env file pull ${parsed.name} --to-dir <dir> 落盘后传路径`, 'yellow'))
    const env = createRunEnv(resolved.vars)
    stage = 'spawn'
    const result = await runProcess(parsed.command, parsed.args, env)
    if (result.errorCode === 'E2BIG')
      logger.error(colorText(`env run: 环境变量总大小超过平台上限（E2BIG）。改用 initx env file pull ${parsed.name} --to-dir <dir> 落盘后用路径传参`, 'red'))
    else if (result.errorCode)
      logger.error(colorText(`env run: 启动失败（${result.errorCode}）`, 'red'))
    applyRunResult(result)
  }
  catch (error) {
    if (stage === 'store' && config && (ctx.options.boolean('debug') || ctx.options.boolean('d')))
      logger.debug(colorText(`env run: 后端=${config.type}，profile=${config.profile}（来自 ${config.profileSource}），凭据来源=${config.tokenSource}`, 'gray'))

    logger.error(colorText(`env run: ${STAGE_LABELS[stage]}失败${describeRunError(stage, error)}`, 'red'))
    process.exitCode = 1
  }
}

/**
 * 把错误翻成一句可操作的中文。
 *
 * 两条硬约束：
 * 1. 只输出本项目自己生成的文案，不透传上游响应体、URL、token 或子进程参数。
 * 2. 每个阶段都必须给出具体原因——originally 只有 store 阶段填 detail，
 *    其余阶段一律退化成“某某失败”，使用者无从下手。
 */
function describeRunError(stage: RunStage, error: unknown): string {
  if (error instanceof StorageError)
    return `：${new StorageError(error.code, error.status).message}`
  if (error instanceof StoreReadError)
    return `：${error.diagnostic()}`
  if (error instanceof FileRefError)
    return `：${error.message}`
  if (error instanceof ProfileError)
    return `：${error.message}`

  // 参数、配置、变量校验阶段的错误由本项目自己抛出，message 本就是给用户看的。
  // store 阶段的其余错误可能是上游原生异常，绝不外泄原文。
  if (stage !== 'store' && error instanceof Error && error.message)
    return `：${error.message}`

  return ''
}
