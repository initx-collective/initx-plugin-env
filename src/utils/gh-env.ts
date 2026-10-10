/**
 * 把变量注入「当前 CI job 的环境」。
 *
 * - GitHub Actions 下写 `$GITHUB_ENV` 文件（同一 job 的后续 step 可见），并先发 `::add-mask::` 脱敏；
 * - 其它情况（或 `forceStdout`）打印到 stdout，方便本地查看或 `eval "$(cmd)"`。
 *
 * 除 `injectEnv`（写文件 / 打印）外，本模块所有函数都没有副作用。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import process from 'node:process'

/* eslint-disable no-console -- 本模块的职责就是按 GitHub Actions 协议把 ::add-mask:: 和 KEY=value 打到 stdout */

export interface InjectOptions {
  forceStdout?: boolean
  mask?: boolean
}

export interface InjectResult {
  target: 'github_env' | 'stdout'
  injected: string[]
  masked: string[]
}

/** GitHub Actions 环境判定：GITHUB_ACTIONS === 'true' 或 GITHUB_ENV 非空 */
export function isGitHubActions(): boolean {
  if (process.env.GITHUB_ACTIONS === 'true') {
    return true
  }

  return typeof process.env.GITHUB_ENV === 'string' && process.env.GITHUB_ENV.length > 0
}

/** heredoc 分隔符，例如 EOF_ab12cd34（8 位随机十六进制） */
function createDelimiter(value: string): string {
  let delimiter = `EOF_${randomBytes(4).toString('hex')}`

  // 极小概率与内容撞车；撞了就重新生成，避免 heredoc 被内容里的同名行提前结束
  while (value.includes(delimiter)) {
    delimiter = `EOF_${randomBytes(4).toString('hex')}`
  }

  return delimiter
}

/**
 * 生成要追加到 `$GITHUB_ENV` 的内容（纯函数，不含前后换行，方便测试）。
 *
 * GitHub 的硬格式（写错会静默失效）：
 * - 单行值：`KEY=value`
 * - 含换行的值：heredoc，分隔符随机且必须独占一行、首尾完全一致
 *   ```
 *   KEY<<EOF_ab12cd34
 *   第一行
 *   第二行
 *   EOF_ab12cd34
 *   ```
 */
export function renderGithubEnvLines(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => {
      if (!value.includes('\n')) {
        return `${key}=${value}`
      }

      const delimiter = createDelimiter(value)

      return [`${key}<<${delimiter}`, value, delimiter].join('\n')
    })
    .join('\n')
}

/** 需要引号保护的值：含空白（空格/制表/换行）、单双引号或 `$` */
const NEEDS_QUOTING = /[\s'"$]/

/** 双引号内仍需转义的字符 */
const DOUBLE_QUOTE_SPECIALS = /[\\"$`]/g

/**
 * 生成要打印到 stdout 的内容（纯函数）。
 *
 * 引号规则（刻意保持可移植，不用 bash 专有的 `$'...'`）：
 * - 值只含安全字符时直接 `KEY=value`，不加引号；
 * - 含空格 / 引号 / `$` / 换行的值用单引号包裹，内部单引号按 `'\''` 转义
 *   （例如 `it's` → `'it'\''s'`）；
 * - 含换行的值**不用** `$'...'`（zsh/dash 不通用），改用双引号 `KEY="..."`，
 *   并把真实换行转义成字面量 `\n`，同时转义 `\`、`"`、`$`、反引号。
 *   注意：双引号里的 `\n` 在 shell 中是两个字符而不是真换行，所以 stdout 形式
 *   适合查看/复制，不要指望 `eval` 之后还能拿回原始的多行值。
 */
export function renderStdoutLines(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => {
      if (value.includes('\n') || value.includes('\r')) {
        const escaped = value
          .replace(DOUBLE_QUOTE_SPECIALS, char => `\\${char}`)
          .replace(/\r\n|\r|\n/g, '\\n')

        return `${key}="${escaped}"`
      }

      if (NEEDS_QUOTING.test(value)) {
        return `${key}='${value.replace(/'/g, `'\\''`)}'`
      }

      return `${key}=${value}`
    })
    .join('\n')
}

/**
 * 发脱敏指令。含换行的值先逐行 mask，再 mask 整体；
 * 逐行时跳过空行（mask 空字符串没有意义）。
 */
function maskValue(value: string): void {
  if (value.includes('\n') || value.includes('\r')) {
    for (const line of value.split(/\r?\n/)) {
      if (line !== '') {
        console.log(`::add-mask::${line}`)
      }
    }
  }

  console.log(`::add-mask::${value}`)
}

/**
 * 把变量注入当前 CI job 的环境。
 *
 * - `!forceStdout` 且 `$GITHUB_ENV` 存在 → 先脱敏，再以追加方式写 `$GITHUB_ENV`
 *   （前面补一个换行，避免与已有内容粘连；文件不存在由 `appendFileSync` 创建）；
 * - 否则 → 打印 `renderStdoutLines` 的结果。
 *
 * 脱敏只在「输出会被 GitHub Actions 记录」时才有意义（`isGitHubActions()`），
 * 否则本地 stdout 会混入 `::add-mask::` 行，`eval "$(cmd)"` 会把它当命令执行。
 * `options.mask === false` 时一律不脱敏（用于非敏感值）。
 */
export function injectEnv(vars: Record<string, string>, options: InjectOptions = {}): InjectResult {
  const { forceStdout = false, mask = true } = options
  const injected = Object.keys(vars)
  const masked: string[] = []

  if (mask && injected.length > 0 && isGitHubActions()) {
    for (const key of injected) {
      maskValue(vars[key])
      masked.push(key)
    }
  }

  const githubEnvPath = forceStdout ? undefined : process.env.GITHUB_ENV

  if (githubEnvPath) {
    const content = renderGithubEnvLines(vars)

    if (content !== '') {
      // 前面先补一个换行：GITHUB_ENV 里已有内容时不会粘在一起
      appendFileSync(githubEnvPath, `\n${content}`, { encoding: 'utf8' })
    }

    return { target: 'github_env', injected, masked }
  }

  const content = renderStdoutLines(vars)

  if (content !== '') {
    console.log(content)
  }

  return { target: 'stdout', injected, masked }
}
