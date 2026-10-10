/**
 * 把 initx 传进来的 `ctx.cliOptions`（cac 解析结果）包一层，
 * 免得每个命令都去处理 kebab-case / camelCase / boolean-only 三种形态。
 *
 * cac 的规则：`--dry-run` 会同时产生 `dry-run` 和 `dryRun` 两个键；
 * `--global`（无值）只在 `optionsList` 里以字符串 `--global` 出现。
 */
export interface CliOptions {
  string: (name: string) => string | undefined
  boolean: (name: string) => boolean
  has: (name: string) => boolean
  raw: Record<string, unknown>
}

function toCamel(name: string): string {
  return name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
}

function pick(raw: Record<string, unknown>, name: string): unknown {
  return raw[name] ?? raw[toCamel(name)]
}

function normalize(value: unknown): string | undefined {
  if (typeof value === 'string')
    return value === '' ? undefined : value

  if (typeof value === 'number')
    return String(value)

  if (Array.isArray(value))
    return value.length ? value.map(String).join(',') : undefined

  return undefined
}

export function createCliOptions(
  raw: Record<string, unknown> = {},
  optionsList: string[] = []
): CliOptions {
  const listed = new Set(optionsList)

  return {
    raw,
    string: name => normalize(pick(raw, name)),
    boolean: (name) => {
      const value = pick(raw, name)

      if (typeof value === 'boolean')
        return value

      return listed.has(`--${name}`) || listed.has(`--${toCamel(name)}`)
    },
    has: (name) => {
      if (pick(raw, name) !== undefined)
        return true

      return listed.has(`--${name}`) || listed.has(`--${toCamel(name)}`)
    }
  }
}
