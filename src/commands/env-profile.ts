import type { CliOptions } from '../cli-options'
import type { EnvPluginStore } from '../config'
import type { EnvProfile } from '../profile'
import type { ProjectConfig } from '../project-config'
import process from 'node:process'
import { inquirer, logger } from '@initx-plugin/utils'
import { DEFAULT_BRANCH, DEFAULT_PATH, defaultApiBaseUrl, normalizeProfile, profileNames, requireProfile, resolveConfig } from '../config'
import { isValidProfileName, normalizeProfileName, sortProfileNames } from '../profile'
import { createStorageAdapter } from '../storage/factory'
import { assertSafePath, normalizeApiBaseUrl, validateStorageRepo } from '../storage/path'
import { listStores } from '../store'
import { colorText } from '../utils/terminal'

/**
 * profile 管理命令：setup / edit / use / profiles / rm-profile。
 *
 * 取代旧的 `env-config` 命令族。旧命令是"逐项 set 到一份全局配置"，
 * 结果是切换后端就会覆盖掉另一套；这里每个 profile 自包含，互不影响。
 */

const TOKEN_WARNING = 'token 会以**明文**存在 ~/.initx/stores/@initx-plugin/env/store.json；'
  + 'CI 里请改用环境变量 INITX_ENV_TOKEN。'

export interface ProfileContext {
  store: EnvPluginStore
  options: CliOptions
  project?: ProjectConfig | null
}

export async function handleProfile(ctx: ProfileContext, action: string, args: string[]): Promise<void> {
  switch (action) {
    case 'setup':
      return runSetup(ctx, args)
    case 'edit':
      return runEdit(ctx, args)
    case 'use':
      return runUse(ctx, args)
    case 'profiles':
      return runProfiles(ctx)
    case 'status':
      return printStatus(ctx)
    case 'rm-profile':
      return runRemoveProfile(ctx, args)
    default:
      throw new Error(`未知 profile 命令 "${action}"，可用：setup | edit | use | profiles | status | rm-profile`)
  }
}

function profilesOf(store: EnvPluginStore): Record<string, EnvProfile> {
  return (store.profiles ??= {})
}

/** 输入校验：类型、API 地址、仓库、目录，逐项报人话错误。 */
function buildProfile(input: {
  type: string
  apiBaseUrl: string
  repo: string
  branch: string
  path: string
  token: string
}): EnvProfile {
  const type = input.type.trim().toLowerCase()
  if (type !== 'github' && type !== 'gitlab')
    throw new Error('storage.type 必须是 github 或 gitlab')

  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl.trim() || defaultApiBaseUrl(type))
  const repo = input.repo.trim()
  if (!repo)
    throw new Error('vault 仓库不能为空')

  try {
    validateStorageRepo(type, repo)
  }
  catch {
    throw new Error(`vault 仓库不合法："${repo}"（应为 owner/repo 或 GitLab 的 group/subgroup/repo）`)
  }

  const branch = input.branch.trim() || DEFAULT_BRANCH
  const path = input.path.trim() === '' ? DEFAULT_PATH : input.path.trim()

  try {
    assertSafePath(path, true)
  }
  catch {
    throw new Error(`store 目录不合法："${path}"`)
  }

  return { type, apiBaseUrl, repo, branch, path, token: input.token || undefined }
}

async function askProfile(base: EnvProfile | undefined): Promise<EnvProfile> {
  const type = await inquirer.input('类型 (github/gitlab)', {
    default: base?.type ?? 'github',
    required: true
  })
  const normalizedType = type.trim().toLowerCase()
  if (normalizedType !== 'github' && normalizedType !== 'gitlab')
    throw new Error('类型必须是 github 或 gitlab')

  const apiBaseUrl = await inquirer.input('API 地址', {
    default: base?.apiBaseUrl ?? defaultApiBaseUrl(normalizedType),
    required: true
  })

  const repo = await inquirer.input('vault 仓库', {
    default: base?.repo ?? '',
    required: true
  })

  const branch = await inquirer.input('分支', { default: base?.branch ?? DEFAULT_BRANCH })
  const path = await inquirer.input('store 目录', { default: base?.path ?? DEFAULT_PATH })

  const token = await inquirer.password(
    base?.token ? 'token（回车保持不变）' : 'token',
    { mask: '*' }
  )

  return buildProfile({
    type: normalizedType,
    apiBaseUrl,
    repo,
    branch,
    path,
    token: token || base?.token || ''
  })
}

async function requireTTY(command: string): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${command} 需要交互式终端。\n`
      + '  CI / 脚本里请改用 INITX_ENV_TOKEN 提供 token，仓库定位写在项目 initx-env.config.ts'
    )
  }
}

async function runSetup(ctx: ProfileContext, args: string[]): Promise<void> {
  await requireTTY('setup')

  const profiles = profilesOf(ctx.store)
  const explicitName = args[0] ? normalizeProfileName(args[0]) : undefined
  const base = explicitName ? profiles[explicitName] : undefined

  // 名字已存在时只问"是否覆盖"，不给第三个选项——避免交互分支过多。
  if (explicitName && base) {
    logger.warn(colorText(`profile "${explicitName}" 已存在（${base.type} · ${base.repo}）`, 'yellow'))
    const overwrite = await inquirer.confirm('覆盖？')
    if (!overwrite) {
      logger.info('已取消，未做改动')
      return
    }
  }

  const profile = await askProfile(base)

  // 覆盖时不重新问名字；新建时最后一步才问。
  let name: string
  if (explicitName) {
    name = explicitName
  }
  else {
    const answer = await inquirer.input('profile 名称', {
      default: 'default',
      required: true
    })
    name = normalizeProfileName(answer)
  }

  if (!isValidProfileName(name))
    throw new Error(`profile 名不合法："${name}"`)

  profiles[name] = profile
  ctx.store.defaultProfile ??= name

  logger.success(colorText(`profile "${name}" 已保存（${profile.type} · ${profile.repo}）`, 'green'))
  logger.warn(colorText(TOKEN_WARNING, 'yellow'))

  if (ctx.store.defaultProfile === name)
    logger.info(`当前默认 profile：${colorText(name, 'blue')}`)
}

async function runEdit(ctx: ProfileContext, args: string[]): Promise<void> {
  await requireTTY('edit')

  const name = args[0] ? normalizeProfileName(args[0]) : await pickProfile(ctx.store, '修改哪个 profile')
  const current = requireProfile(ctx.store, name)

  logger.info(`profile ${colorText(name, 'blue')} 当前配置：`)
  logger.info(`  类型: ${current.type}`)
  logger.info(`  API: ${current.apiBaseUrl}`)
  logger.info(`  仓库: ${current.repo}`)
  logger.info(`  分支: ${current.branch ?? DEFAULT_BRANCH}`)
  logger.info(`  目录: ${current.path ?? DEFAULT_PATH}`)
  logger.info(`  token: ${current.token ? '***' : '(未设置)'}`)
  logger.info('（除 token 外，直接回车即保持原值）')

  const type = await inquirer.input('类型 (github/gitlab)', {
    default: current.type,
    required: true
  })
  const normalizedType = type.trim().toLowerCase()
  if (normalizedType !== 'github' && normalizedType !== 'gitlab')
    throw new Error('类型必须是 github 或 gitlab')

  const apiBaseUrl = await inquirer.input('API 地址', { default: current.apiBaseUrl, required: true })
  const repo = await inquirer.input('vault 仓库', { default: current.repo, required: true })
  const branch = await inquirer.input('分支', { default: current.branch ?? DEFAULT_BRANCH })
  const path = await inquirer.input('store 目录', { default: current.path ?? DEFAULT_PATH })
  const token = await inquirer.password('token（回车保持不变）', { mask: '*' })

  const next = buildProfile({
    type: normalizedType,
    apiBaseUrl,
    repo,
    branch,
    path,
    token: token || current.token || ''
  })

  let changed = 0
  for (const key of Object.keys(next) as (keyof EnvProfile)[]) {
    if (next[key] !== current[key])
      changed++
  }

  if (!changed) {
    logger.info(`profile "${colorText(name, 'blue')}" 无需改动`)
    return
  }

  profilesOf(ctx.store)[name] = next
  logger.success(colorText(`profile "${name}" 已更新（${changed} 项）`, 'green'))
}

async function runUse(ctx: ProfileContext, args: string[]): Promise<void> {
  const names = profileNames(ctx.store)

  if (!names.length)
    throw new Error('本机还没有任何 profile\n  新建：ix env setup')

  const name = args[0] ? normalizeProfileName(args[0]) : await pickProfile(ctx.store, '设为默认 profile')

  requireProfile(ctx.store, name)
  ctx.store.defaultProfile = name

  logger.success(colorText(`默认 profile 已切换为 "${name}"`, 'green'))
}

function describe(profile: EnvProfile): string {
  const normalized = normalizeProfile(profile)
  return `${normalized.type.padEnd(6)}  ${normalized.apiBaseUrl}  ${normalized.repo}`
}

async function runProfiles(ctx: ProfileContext): Promise<void> {
  const names = sortProfileNames(Object.keys(ctx.store.profiles ?? {}))

  if (!names.length) {
    logger.warn(colorText('本机还没有任何 profile', 'yellow'))
    logger.info('新建：ix env setup')
    return
  }

  const current = currentProfileName(ctx)

  for (const name of names) {
    const mark = name === ctx.store.defaultProfile ? '*' : ' '
    const currentMark = name === current ? colorText('  ← 当前项目', 'gray') : ''
    logger.info(`${mark} ${colorText(name.padEnd(12), 'blue')}  ${describe(ctx.store.profiles![name]!)}${currentMark}`)
  }
}

/**
 * 当前生效的 profile：项目文件能匹配到就用它，否则回落到默认。
 *
 * 这里吞掉所有错误——`profiles` 是查看命令，不应该因为"项目指向一个不存在的
 * profile"就整个失败，那样用户反而看不到有哪些 profile 可改。
 */
function currentProfileName(ctx: ProfileContext): string | undefined {
  try {
    return resolveConfig(ctx.store, {
      profile: ctx.options.string('profile') || undefined,
      project: ctx.project
    }).profile
  }
  catch {
    return ctx.store.defaultProfile
  }
}

async function runRemoveProfile(ctx: ProfileContext, args: string[]): Promise<void> {
  const name = args[0] ? normalizeProfileName(args[0]) : await pickProfile(ctx.store, '删除哪个 profile')

  requireProfile(ctx.store, name)

  if (name === ctx.store.defaultProfile && !ctx.options.boolean('force')) {
    throw new Error(
      `"${name}" 是默认 profile，不能直接删除\n`
      + `  先切换：ix env use <另一个 profile>\n`
      + `  或强制删除：ix env rm-profile ${name} --force`
    )
  }

  const names = profileNames(ctx.store)
  if (names.length === 1) {
    throw new Error(
      '这是最后一个 profile，不能删除\n'
      + '  如果确实要清空，请手动删除 ~/.initx/stores/@initx-plugin/env/store.json'
    )
  }

  delete profilesOf(ctx.store)[name]

  if (ctx.store.defaultProfile === name) {
    const next = profileNames(ctx.store)[0]!
    ctx.store.defaultProfile = next
    logger.warn(colorText(`默认 profile 已回落到 "${next}"`, 'yellow'))
  }

  logger.success(colorText(`profile "${name}" 已删除`, 'green'))
}

/** 没有显式名字时让用户从列表里选。 */
async function pickProfile(store: EnvPluginStore, message: string): Promise<string> {
  const names = sortProfileNames(Object.keys(store.profiles ?? {}))

  if (!names.length)
    throw new Error('本机还没有任何 profile\n  新建：ix env setup')

  if (names.length === 1)
    return names[0]!

  if (!process.stdin.isTTY)
    throw new Error(`有多个 profile，非交互环境必须指定名字：\n  ${names.join('\n  ')}`)

  const index = await inquirer.select(message, names)
  return names[index]!
}

/** `status` 借用：打印当前实际生效的配置与来源。 */
export async function printStatus(ctx: ProfileContext): Promise<void> {
  const { resolveConfig } = await import('../config')
  const config = resolveConfig(ctx.store, {
    profile: ctx.options.string('profile') || undefined,
    project: ctx.project
  })

  logger.info(`profile: ${colorText(config.profile, 'blue')}（来自 ${config.profileSource}）`)
  logger.info(`存储后端: ${colorText(config.type, 'blue')}`)
  logger.info(`API 地址: ${colorText(config.apiBaseUrl, 'blue')}`)
  logger.info(`vault 仓库: ${colorText(config.repo, 'blue')}`)
  logger.info(`分支: ${colorText(config.branch, 'blue')}`)
  logger.info(`store 目录: ${colorText(config.path, 'blue')}`)
  logger.info(`配置来源: ${colorText(config.configSource, 'blue')}`)
  logger.info(`token: ${colorText(config.token ? '***' : '(未设置)', 'yellow')}（来自 ${config.tokenSource}）`)

  if (ctx.options.boolean('offline')) {
    logger.info(colorText('（--offline：跳过连通性检查）', 'gray'))
    return
  }

  const client = createStorageAdapter({ ...config, debug: ctx.options.boolean('debug') || ctx.options.boolean('d') })
  const stores = await listStores(client, config.path)
  logger.success(colorText(`连通正常，${config.path}/ 下有 ${stores.length} 个 store`, 'green'))
}
