import { describe, expect, it } from 'vitest'
import { createRunEnv, parseRunArgs } from '../commands/env-run'

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
