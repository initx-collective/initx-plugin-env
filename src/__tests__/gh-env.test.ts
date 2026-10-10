import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { injectEnv, isGitHubActions, renderGithubEnvLines, renderStdoutLines } from '../utils/gh-env'

const originalGithubActions = process.env.GITHUB_ACTIONS
const originalGithubEnv = process.env.GITHUB_ENV

let tempDir: string | undefined

function restoreEnv(name: 'GITHUB_ACTIONS' | 'GITHUB_ENV', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  }
  else {
    process.env[name] = value
  }
}

/** 建临时目录并把 $GITHUB_ENV 指过去（模拟 runner 提供的 env 文件） */
function useTempGithubEnv(initialContent?: string): string {
  tempDir = mkdtempSync(join(tmpdir(), 'initx-gh-env-'))
  const file = join(tempDir, 'github_env')

  if (initialContent !== undefined) {
    writeFileSync(file, initialContent, 'utf8')
  }

  process.env.GITHUB_ENV = file

  return file
}

/** 取回 console.log 调用里每次的第一个参数 */
function loggedLines(log: { mock: { calls: unknown[][] } }): unknown[] {
  return log.mock.calls.map(call => call[0])
}

afterEach(() => {
  vi.restoreAllMocks()
  restoreEnv('GITHUB_ACTIONS', originalGithubActions)
  restoreEnv('GITHUB_ENV', originalGithubEnv)

  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('isGitHubActions', () => {
  it('gITHUB_ACTIONS === true 时为真', () => {
    delete process.env.GITHUB_ENV
    process.env.GITHUB_ACTIONS = 'true'
    expect(isGitHubActions()).toBe(true)
  })

  it('只有 GITHUB_ENV 时也为真', () => {
    delete process.env.GITHUB_ACTIONS
    process.env.GITHUB_ENV = 'C:\\temp\\github_env'
    expect(isGitHubActions()).toBe(true)
  })

  it('都没有时为假，GITHUB_ENV 为空串时也为假', () => {
    delete process.env.GITHUB_ACTIONS
    delete process.env.GITHUB_ENV
    expect(isGitHubActions()).toBe(false)

    process.env.GITHUB_ENV = ''
    expect(isGitHubActions()).toBe(false)
  })
})

describe('renderGithubEnvLines', () => {
  it('单行值输出 KEY=value', () => {
    expect(renderGithubEnvLines({ FOO: 'bar' })).toBe('FOO=bar')
  })

  it('多个单行值用换行连接', () => {
    expect(renderGithubEnvLines({ A: '1', B: '2' })).toBe('A=1\nB=2')
  })

  it('空值输出 KEY=', () => {
    expect(renderGithubEnvLines({ EMPTY: '' })).toBe('EMPTY=')
  })

  it('值里的 = 和空格原样保留', () => {
    expect(renderGithubEnvLines({ FOO: 'a = b c' })).toBe('FOO=a = b c')
  })

  it('含换行的值用 heredoc，分隔符形如 EOF_xxxxxxxx 且首尾一致', () => {
    const output = renderGithubEnvLines({ MULTI: 'line1\nline2' })

    expect(output).toMatch(/^MULTI<<EOF_[0-9a-f]{8}$/m)

    const [first, ...rest] = output.split('\n')
    const delimiter = first.slice(first.indexOf('<<') + 2)

    expect(delimiter).toMatch(/^EOF_[0-9a-f]{8}$/)
    expect(rest[rest.length - 1]).toBe(delimiter)
    expect(output.split('\n')).toEqual([`MULTI<<${delimiter}`, 'line1', 'line2', delimiter])
  })

  it('多行值里的 = 与空格原样保留', () => {
    const output = renderGithubEnvLines({ M: 'a=1\nb = 2' })
    const delimiter = output.split('\n')[0].slice('M<<'.length)

    expect(output).toBe(`M<<${delimiter}\na=1\nb = 2\n${delimiter}`)
  })

  it('单行值和多行值混用时都能正确渲染', () => {
    const output = renderGithubEnvLines({ FOO: 'bar', MULTI: 'x\ny' })

    expect(output).toMatch(/^FOO=bar\nMULTI<<EOF_[0-9a-f]{8}\nx\ny\nEOF_[0-9a-f]{8}$/)
  })
})

describe('renderStdoutLines', () => {
  it('普通值不加引号', () => {
    expect(renderStdoutLines({ FOO: 'bar', PORT: '8080' })).toBe('FOO=bar\nPORT=8080')
  })

  it('含空格的值被单引号包裹', () => {
    expect(renderStdoutLines({ FOO: 'a b' })).toBe(`FOO='a b'`)
  })

  it('含单引号的值按 结束-转义-重开 处理', () => {
    expect(renderStdoutLines({ FOO: `it's` })).toBe(`FOO='it'\\''s'`)
  })

  it('含 $ 的值被单引号包裹', () => {
    expect(renderStdoutLines({ FOO: '$HOME' })).toBe(`FOO='$HOME'`)
  })

  it('含换行的值用双引号并把换行转义为 \\n', () => {
    expect(renderStdoutLines({ FOO: 'a\nb' })).toBe('FOO="a\\nb"')
  })

  it('多行值里的双引号与反斜杠会被转义', () => {
    expect(renderStdoutLines({ FOO: 'a "b"\\c\nd' })).toBe('FOO="a \\"b\\"\\\\c\\nd"')
  })

  it('cRLF 也走多行分支', () => {
    expect(renderStdoutLines({ FOO: 'a\r\nb' })).toBe('FOO="a\\nb"')
  })
})

describe('injectEnv', () => {
  it('$GITHUB_ENV 存在时写入该文件（不存在则创建），返回 injected', () => {
    const file = useTempGithubEnv()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = injectEnv({ FOO: 'bar' })

    expect(result.target).toBe('github_env')
    expect(result.injected).toEqual(['FOO'])
    // GITHUB_ENV 存在本身就算 CI 环境，所以写文件前一定会脱敏
    expect(result.masked).toEqual(['FOO'])
    expect(loggedLines(log)).toEqual(['::add-mask::bar'])
    expect(readFileSync(file, 'utf8')).toBe('\nFOO=bar')
  })

  it('追加内容前有换行，已有内容不被破坏', () => {
    const file = useTempGithubEnv('EXISTING=1')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = injectEnv({ FOO: 'bar', MULTI: 'line1\nline2' })

    expect(result.injected).toEqual(['FOO', 'MULTI'])

    const content = readFileSync(file, 'utf8')

    expect(content).toContain('EXISTING=1\nFOO=bar')
    expect(content).toContain('\nFOO=bar')
    // 多行值按 heredoc 写入，分隔符首尾一致
    expect(content).toMatch(/\nMULTI<<(EOF_[0-9a-f]{8})\nline1\nline2\n\1$/)
  })

  it('在 CI 中会先发 ::add-mask:: 再写文件', () => {
    process.env.GITHUB_ACTIONS = 'true'
    const file = useTempGithubEnv()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = injectEnv({ SECRET: 's3cr3t' })

    expect(result.masked).toEqual(['SECRET'])
    expect(loggedLines(log)).toEqual(['::add-mask::s3cr3t'])
    expect(readFileSync(file, 'utf8')).toBe('\nSECRET=s3cr3t')
  })

  it('多行值逐行脱敏后再整体脱敏', () => {
    process.env.GITHUB_ACTIONS = 'true'
    useTempGithubEnv()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = injectEnv({ MULTI: 'line1\nline2' })

    expect(result.masked).toEqual(['MULTI'])
    expect(loggedLines(log)).toEqual([
      '::add-mask::line1',
      '::add-mask::line2',
      '::add-mask::line1\nline2'
    ])
  })

  it('mask: false 时不发脱敏指令', () => {
    process.env.GITHUB_ACTIONS = 'true'
    const file = useTempGithubEnv()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = injectEnv({ FOO: 'bar' }, { mask: false })

    expect(result.masked).toEqual([])
    expect(log).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe('\nFOO=bar')
  })

  it('forceStdout: true 时走 stdout，本地不夹带 ::add-mask::', () => {
    delete process.env.GITHUB_ACTIONS
    delete process.env.GITHUB_ENV
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = injectEnv({ FOO: 'bar', SPACED: 'a b' }, { forceStdout: true })

    expect(result).toEqual({ target: 'stdout', injected: ['FOO', 'SPACED'], masked: [] })
    expect(loggedLines(log)).toEqual([`FOO=bar\nSPACED='a b'`])
  })

  it('cI 里 forceStdout: true 时会脱敏', () => {
    delete process.env.GITHUB_ENV
    process.env.GITHUB_ACTIONS = 'true'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = injectEnv({ SECRET: 's3cr3t' }, { forceStdout: true })

    expect(result.target).toBe('stdout')
    expect(result.masked).toEqual(['SECRET'])
    expect(loggedLines(log)).toEqual(['::add-mask::s3cr3t', 'SECRET=s3cr3t'])
  })

  it('$GITHUB_ENV 为空串时退回 stdout', () => {
    delete process.env.GITHUB_ACTIONS
    process.env.GITHUB_ENV = ''
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = injectEnv({ FOO: 'bar' })

    expect(result.target).toBe('stdout')
    expect(loggedLines(log)).toEqual(['FOO=bar'])
  })

  it('空对象不产生输出、也不创建文件', () => {
    const file = useTempGithubEnv()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = injectEnv({})

    expect(result).toEqual({ target: 'github_env', injected: [], masked: [] })
    expect(log).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
  })
})
