import type { CliOptions } from '../cli-options'
import type { EnvPluginStore } from '../config'
import { Buffer } from 'node:buffer'
import { logger } from '@initx-plugin/utils'
import { configFileOption } from '../cli-options'
import { resolveConfig } from '../config'
import { createStorageAdapter } from '../storage/factory'
import { validateStorageRepo } from '../storage/path'
import { readStore } from '../store'
import { createGitHubActionsTarget } from '../targets/github-actions'
import { normalizeStoreName, validateSecretName } from '../types'
import { colorText } from '../utils/terminal'

/**
 * `npx initx env apply <store>` —— 把 store 里的变量写进某个仓库的 Actions secrets。
 *
 * 这是这个插件唯一"回写 CI"的能力，也是它跟 dotenvx / sops / 1Password 那些
 * 工具的分界：它们都是把 secret **注入**进程，没有一个往 GitHub 的 secret 存储里写。
 *
 * 三个必须记住的约束（写在代码里免得以后忘）：
 *   1. secret 值**只写不读** → 没有反向同步，`--dry-run` 也只能列名字；
 *   2. 单条上限 **48 KB**；
 *   3. 变量名必须符合 GitHub 的命名规则，且**一律按大写存储**。
 */

export interface ApplyContext {
  store: EnvPluginStore
  options: CliOptions
}

const MAX_SECRET_BYTES = 48 * 1024

export async function handleEnvApply(ctx: ApplyContext, args: string[]): Promise<void> {
  const [rawName] = args

  if (!rawName) {
    throw new Error('用法：npx initx env apply <store 名> --repo <owner/repo> [--env <环境名>] [--only A,B] [--dry-run]')
  }

  const name = normalizeStoreName(rawName)

  // 注意：这里的 `--repo` 是**写入目标**仓库，不是 vault 仓库，
  // 所以不把它传给 resolveConfig。
  const config = resolveConfig(ctx.store, { token: ctx.options.string('token'), config: configFileOption(ctx.options) })
  const client = createStorageAdapter({ ...config, debug: ctx.options.boolean('debug') || ctx.options.boolean('d') })
  const destination = createGitHubActionsTarget(config, ctx.options.string('target-token'))
  const ref = await readStore(client, config.path, name)

  if (!ref) {
    throw new Error(`仓库里没有 store "${name}"。用 npx initx env list 看看有哪些`)
  }

  const target = ref.store.targets?.secrets?.[0]
  const targetRepo = ctx.options.string('repo') ?? target?.repo

  if (!targetRepo) {
    throw new Error('要指定写入目标：--repo <owner/repo>，或在 store 里写 targets.secrets')
  }
  validateStorageRepo('github', targetRepo)

  const targetEnv = ctx.options.string('env') ?? target?.env ?? null
  const only = ctx.options.string('only')?.split(',').map(item => item.trim()).filter(Boolean)
  const entries = Object.entries(ref.store.vars)
    .filter(([key]) => !only || only.includes(key))

  if (!entries.length) {
    throw new Error(only?.length ? `--only 里没有任何变量命中 store "${name}"` : `store "${name}" 里没有变量`)
  }

  const problems: string[] = []

  for (const [key, value] of entries) {
    const nameError = validateSecretName(key)

    if (nameError) {
      problems.push(`${key} — 名字不合法：${nameError}`)
      continue
    }

    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES)
      problems.push(`${key} — 值超过 48 KB 上限`)
  }

  if (problems.length) {
    logger.error(colorText('这些变量不能写进 Actions secrets：', 'red'))
    for (const problem of problems)
      logger.error(colorText(`  ${problem}`, 'red'))

    if (!ctx.options.boolean('skip-invalid')) {
      throw new Error(`有 ${problems.length} 个变量不合法，已中止（改名后用 --only 排除，或加 --skip-invalid 跳过）`)
    }

    logger.warn(colorText('--skip-invalid：跳过这些变量', 'yellow'))
  }

  const blocked = new Set(problems.map(problem => problem.split(' — ')[0]!))
  const writable = entries.filter(([key]) => !blocked.has(key))

  if (ctx.options.boolean('dry-run')) {
    logger.info(`${colorText('--dry-run', 'yellow')}：将写入 ${writable.length} 个 secret → ${colorText(targetRepo, 'blue')}${targetEnv ? `（环境 ${colorText(targetEnv, 'blue')}）` : '（仓库级）'}`)
    for (const [key] of writable)
      logger.info(`  ${colorText(key, 'blue')}`)
    return
  }

  logger.info(`写入 ${colorText(targetRepo, 'blue')}${targetEnv ? `（环境 ${colorText(targetEnv, 'blue')}）` : '（仓库级）'} …`)

  const failures: string[] = []

  // 串行：并发 PUT 中途失败既没有原子性，也不好汇总（`gh secret set -f` 就是并发）
  for (const [key, value] of writable) {
    try {
      const result = await destination.write(targetRepo, key, value, targetEnv)
      logger.success(colorText(`${key}: ${result === 'created' ? '新建' : '更新'}`, 'green'))
    }
    catch (error) {
      failures.push(key)
      logger.error(colorText(`${key}: 失败 — ${(error as Error).message}`, 'red'))
    }
  }

  if (failures.length)
    throw new Error(`${failures.length} 个 secret 写入失败：${failures.join(', ')}`)

  logger.success(colorText(`完成：${writable.length} 个 secret → ${targetRepo}`, 'green'))
  if (targetEnv)
    logger.info(`环境级 secret 需要该 environment 已存在，且 job 引用它时才可用`)
}
