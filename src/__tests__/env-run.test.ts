import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '@initx-plugin/utils'
import { describe, expect, it, vi } from 'vitest'
import { createRunEnv, handleEnvRun, parseRunArgs } from '../commands/env-run'

describe('run 参数及环境校验', () => {
  it('保留每个尾部参数，独立校验分隔符和命令', () => {
    const args = ['', 'a b', '"quoted"', '你好', 'a=b', '--', '--help', '--version', '--token=child']
    expect(parseRunArgs(['demo.json'], ['node', ...args])).toEqual({ name: 'demo', command: 'node', args })
    for (const [prefix, tail] of [[[], ['node']], [['demo', 'extra'], ['node']], [[''], ['node']], [['demo'], undefined], [['demo'], []], [['demo'], ['']], [['demo'], ['  ']], [['demo'], [42]], [['demo'], ['node', '\0']]] as [string[], unknown][])
      expect(() => parseRunArgs(prefix, tail)).toThrow()
  })

  it('覆盖并保留其他父变量，不展开值或修改输入', () => {
    const parent = { A: 'old', KEEP: 'keep', GH_TOKEN: 'inherited', PATH: '/bin' }
    const vars = { A: '', TEXT: 'line\ncrlf\r\n\\$VAR$' + '{VAR};`x`$(x)"你好' }
    expect(createRunEnv(vars, parent, 'linux')).toEqual({ ...parent, ...vars })
    expect(parent.A).toBe('old')
  })

  it('在 Windows 合并大小写别名并拒绝 store 冲突；Linux 区分大小写', () => {
    expect(createRunEnv({ PATH: 'new' }, { Path: 'old', PATH: 'other', Keep: 'k' }, 'win32')).toEqual({ PATH: 'new', Keep: 'k' })
    expect(Object.keys(createRunEnv({}, { Path: 'a', PATH: 'b' }, 'win32')).filter(key => key.toUpperCase() === 'PATH')).toHaveLength(1)
    expect(() => createRunEnv({ FOO: 'a', foo: 'b' }, {}, 'win32')).toThrow(/冲突/)
    expect(createRunEnv({ FOO: 'a', foo: 'b' }, {}, 'linux')).toEqual({ FOO: 'a', foo: 'b' })
  })

  it('所有坏变量均中止，错误不含值，空 store 允许执行', () => {
    for (const key of ['1bad', 'my-key', 'my.key', 'A=B', 'N\0UL', '空格', ''])
      expect(() => createRunEnv({ [key]: 'secret-sentinel' }, {})).toThrow(/变量名/)
    expect(() => createRunEnv({ KEY: 'secret-sentinel\0' }, {})).toThrow('变量 "KEY" 必须是字符串且不能包含 NUL')
    expect(createRunEnv({}, { KEEP: 'yes' })).toEqual({ KEEP: 'yes' })
  })
})

describe('run 错误输出', () => {
  /** 造一个最小 ctx：handleEnvRun 只读 store、options.raw 和几个取值方法。 */
  function makeCtx(raw: Record<string, unknown> = {}) {
    return {
      store: {},
      options: {
        raw,
        string: (key: string) => raw[key] as string | undefined,
        boolean: (key: string) => Boolean(raw[key])
      }
    } as unknown as Parameters<typeof handleEnvRun>[0]
  }

  it('配置阶段失败时透出真实原因，而不是只留一句配置失败', async () => {
    // 空 store + 指向一个空 storage 的项目文件，命中 resolveConfig 的 ProfileError
    const dir = mkdtempSync(join(tmpdir(), 'initx-env-run-'))
    const file = join(dir, '.initx-env.json')
    writeFileSync(file, JSON.stringify({ schema: 1, storage: { type: 'gitlab', repo: '' } }), 'utf8')

    const logs: string[] = []
    const spy = vi.spyOn(logger, 'error').mockImplementation((msg: unknown) => {
      logs.push(String(msg))
    })

    try {
      // args 只放 store 名；子进程命令走 raw['--']
      await handleEnvRun(makeCtx({ 'config': file, '--': ['env'] }), ['acewill-npm'])
    }
    finally {
      spy.mockRestore()
    }

    const output = logs.join('\n')
    expect(output).toContain('配置失败')
    // 关键是冒号后要有内容：证明 detail 没有被丢掉
    expect(output).toMatch(/配置失败：\S/)
  })
})
