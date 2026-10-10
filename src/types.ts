import { z } from 'zod'

/** store 文件的 schema 版本。将来结构变了要在这里升版本 + 写迁移。 */
export const STORE_SCHEMA_VERSION = 1

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
 * 仓库里一个 store 文件（`<path>/<name>.json`）的结构。
 *
 * 刻意保持"平"：值一律是字符串，**不做类型转换**（`.env` 里本来就只有字符串）。
 * `targets` 是可选的路由信息，只是省掉交互里的选择步骤，不参与数据本身。
 */
export const storeFileSchema = z.object({
  schema: z.number().int().positive().default(STORE_SCHEMA_VERSION),
  vars: z.record(z.string(), z.string()).default({}),
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
 * store 名 → 文件名 `<name>.json`。
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
