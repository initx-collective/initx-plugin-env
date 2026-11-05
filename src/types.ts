import { z } from 'zod'

/** store 文件的 schema 版本。将来结构变了要在这里升版本 + 写迁移。 */
export const STORE_SCHEMA_VERSION = 1

/**
 * 文件型变量的 id 规则：小写、以字母或数字开头、最多 64 字符，
 * 允许 `-` `_` `.`。它同时是仓库里的文件名，必须过 `assertSafePath`。
 */
export const FILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isValidFileId(id: string): boolean {
  return FILE_ID_PATTERN.test(id)
}

export const FILE_ENCODINGS = ['utf8', 'base64'] as const
export type FileEncoding = (typeof FILE_ENCODINGS)[number]

/**
 * `files` 里一个文件对象的元数据。路径不存，固定按
 * `<path>/<store>/_files/<id>` 推导。
 *
 * - `sha256` 是内容哈希：解引用校验、push 零下载比对都靠它；
 * - `bytes` 让 48 KB / 1 MiB / 32 KB 这些上限在下载前就能预检；
 * - `encoding` 决定注入形态（文本 / base64 文本），不决定存储形态；
 * - `mode` 是字符串，避免 JSON 数字丢前导零；非 POSIX 平台忽略。
 */
export const fileEntrySchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/, '必须是 64 位小写十六进制'),
  bytes: z.number().int().nonnegative(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  mode: z.string().regex(/^[0-7]{3,4}$/, '必须是 3-4 位八进制').optional()
}).strict()

export type FileEntry = z.infer<typeof fileEntrySchema>

/**
 * `apply` 的目标：把 store 里的变量写进哪个仓库的 Actions secrets。
 * 只有一个仓库时可以不配 `targets.secrets`，用 `--repo` 传。
 */
export const secretTargetSchema = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, '必须是 owner/repo 形式'),
  /** 环境级 secret 的环境名；null/省略 = 仓库级 */
  env: z.string().nullish()
})

export type SecretTarget = z.infer<typeof secretTargetSchema>

/**
 * 仓库里一个 store（`<path>/<name>/env.json`）的结构。
 *
 * 刻意保持"平"：值一律是字符串，**不做类型转换**（`.env` 里本来就只有字符串）。
 * `targets` 是可选的路由信息，只是省掉交互里的选择步骤，不参与数据本身。
 */
export const storeFileSchema = z.object({
  schema: z.number().int().positive().default(STORE_SCHEMA_VERSION),
  vars: z.record(z.string(), z.string()).default({}),
  /** 文件型变量的元数据；没有它时 store 行为与旧版完全一致。 */
  files: z.record(z.string(), fileEntrySchema).optional(),
  targets: z.object({
    /** pull 时写到哪个（些）文件；相对当前工作目录 */
    envFiles: z.array(z.string().min(1)).optional(),
    /** apply 的默认目标 */
    secrets: z.array(secretTargetSchema).optional()
  }).optional()
})

export type StoreFile = z.infer<typeof storeFileSchema>

export function createEmptyStore(): StoreFile {
  return { schema: STORE_SCHEMA_VERSION, vars: {} }
}

/**
 * store 名 → 目录名 `<name>/env.json`。
 *
 * 规则照 initx-plugin-cp 的 `validateKey`（GitHub Contents API 的路径要求），
 * 另外顺手允许用户把 `.json` 后缀写进来（会去掉）。
 */
export function normalizeStoreName(input: string): string {
  const name = input.trim().replace(/\.json$/i, '')

  if (!name)
    throw new Error('store 名不能为空')

  if (name.includes('/') || name.includes('\\'))
    throw new Error(`store 名不能包含路径分隔符："${input}"`)

  if (name === '.' || name === '..')
    throw new Error(`store 名不能是 "${name}"`)

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(name))
    throw new Error('store 名不能包含控制字符')

  if (name.length > 100)
    throw new Error('store 名太长（上限 100 字符）')

  return name
}

/**
 * GitHub Actions secret 的命名规则（官方约束，不合法会直接 400）：
 * 只允许 `[A-Za-z0-9_]`、不能有空格、不能以数字开头、不能以 `GITHUB_` 开头。
 * 返回 null 表示合法，否则返回人话错误。
 *
 * ⚠️ GitHub 一律按大写存储，所以 `my_key` 和 `MY_KEY` 是同一个 secret。
 */
export function validateSecretName(name: string): string | null {
  if (!/^[A-Z_]\w*$/i.test(name))
    return '只允许字母、数字、下划线，且不能以数字开头'

  if (name.toUpperCase().startsWith('GITHUB_'))
    return 'GITHUB_ 前缀是 GitHub 保留的'

  return null
}

/** 变量名在 `.env` 里的合法形态（比 secret 宽松：允许 `-` 和 `.`） */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Z_][\w.-]*$/i.test(key)
}
