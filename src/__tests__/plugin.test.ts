import { describe, expect, it } from 'vitest'
import { createCliOptions } from '../cli-options'
import EnvPlugin from '../index'
import { applyVars, parseStore, serializeStore, storeFilePath } from '../store'
import { createEmptyStore, isValidEnvKey, normalizeStoreName, validateSecretName } from '../types'

/**
 * 这一层不碰网络：只钉住「命令面 + 名字/路径校验 + store 结构」这些
 * 一旦写错就会静默失效的东西（例如 matchinitx 是精确匹配，
 * `optional` 里少一个子命令，那条命令就等于不存在）。
 */
describe('插件规则', () => {
  const plugin = new EnvPlugin()
  const rules = plugin.rules as Array<{ matching: string, optional?: unknown[] }>

  it('env 规则列全了所有子命令', () => {
    const rule = rules.find(item => item.matching === 'env')

    expect(rule).toBeDefined()

    for (const action of [
      'list',
      'ls',
      'pull',
      'set',
      'unset',
      'push',
      'rm',
      'setup',
      'apply',
      'run',
      'file',
      'profile'
    ])
      expect(rule?.optional).toContain(action)

    // 裸 `npx initx env` 也要能进来打帮助
    expect(rule?.optional).toContain(undefined)
  })

  it('只剩 env 一条规则（env-config 已并入 profile 子命令）', () => {
    expect(rules.map(rule => rule.matching)).toEqual(['env'])
  })

  it('defaultStore 为空——唯一真相是 profiles，不预置定位字段', () => {
    expect(plugin.defaultStore).toEqual({})
  })

  it('默认启用 initx-env.config.ts 项目配置', () => {
    expect(plugin.config).toBe(true)
  })
})

describe('createCliOptions', () => {
  it('认 kebab-case、camelCase 和只出现在 optionsList 里的布尔值', () => {
    expect(createCliOptions({ 'dry-run': true }).boolean('dry-run')).toBe(true)
    expect(createCliOptions({ dryRun: true }).boolean('dry-run')).toBe(true)
    expect(createCliOptions({}, ['--prune']).boolean('prune')).toBe(true)
    expect(createCliOptions({}).boolean('prune')).toBe(false)
  })

  it('取字符串值，数组用逗号拼起来', () => {
    expect(createCliOptions({ from: '.env.local' }).string('from')).toBe('.env.local')
    expect(createCliOptions({
      only: ['A', 'B']
    }).string('only')).toBe('A,B')
    expect(createCliOptions({ from: '' }).string('from')).toBeUndefined()
    expect(createCliOptions({ token: 123 as unknown }).string('token')).toBe('123')
  })
})

describe('名字与路径校验', () => {
  it('normalizeStoreName 去掉 .json 后缀并拒绝路径分隔符', () => {
    expect(normalizeStoreName('mail-peon-publish')).toBe('mail-peon-publish')
    expect(normalizeStoreName('mail-peon-publish.json')).toBe('mail-peon-publish')
    expect(() => normalizeStoreName('a/b')).toThrow(/路径分隔符/)
    expect(() => normalizeStoreName('..')).toThrow()
    expect(() => normalizeStoreName('  ')).toThrow()
  })

  it('storeFilePath 拼出 <path>/<name>/env.json 并挡掉越界路径', () => {
    expect(storeFilePath('stores', 'demo')).toBe('stores/demo/env.json')
    expect(storeFilePath('', 'demo')).toBe('demo/env.json')
    expect(storeFilePath('/stores/', 'demo.json')).toBe('stores/demo/env.json')
    // 配置里多写的斜杠会被归一化，但 `..` 这类越界路径直接拒掉
    expect(storeFilePath('/abs', 'demo')).toBe('abs/demo/env.json')
    expect(() => storeFilePath('..', 'demo')).toThrow(/\.\./)
    expect(() => storeFilePath('a/../b', 'demo')).toThrow(/\.\./)
  })

  it('validateSecretName 挡住 GitHub 不接受的变量名', () => {
    expect(validateSecretName('EXTENSION_ID')).toBe(null)
    expect(validateSecretName('_PRIVATE')).toBe(null)
    expect(validateSecretName('1PASSWORD')).toMatch(/数字开头/)
    expect(validateSecretName('GITHUB_TOKEN')).toMatch(/GITHUB_/)
    expect(validateSecretName('github_token')).toMatch(/GITHUB_/)
    expect(validateSecretName('MY-KEY')).toMatch(/下划线/)
    expect(validateSecretName('MY KEY')).toMatch(/下划线/)
  })

  it('isValidEnvKey 比 secret 宽松（.env 里允许 - 和 .）', () => {
    expect(isValidEnvKey('my-key')).toBe(true)
    expect(isValidEnvKey('my.key')).toBe(true)
    expect(isValidEnvKey('1bad')).toBe(false)
    expect(isValidEnvKey('has space')).toBe(false)
  })
})

describe('store 层', () => {
  it('parseStore 补默认值并给出可读的校验错误', () => {
    const store = parseStore('{"vars":{"A":"1"}}', 'demo')

    expect(store.schema).toBe(1)
    expect(store.vars).toEqual({ A: '1' })

    expect(() => parseStore('not json', 'demo')).toThrow(/不是合法 JSON/)
    expect(() => parseStore('{"vars":{"A":1}}', 'demo')).toThrow(/结构不合法/)
  })

  it('serializeStore 是稳定的 JSON（末尾换行、2 空格缩进）', () => {
    const text = serializeStore(createEmptyStore())

    expect(text).toBe('{\n  "schema": 1,\n  "vars": {}\n}\n')
    expect(parseStore(text, 'demo').vars).toEqual({})
  })

  it('applyVars 只动传入的键，并分类 added/updated/unchanged', () => {
    const store = createEmptyStore()
    store.vars = { KEEP: 'x', CHANGE: 'old' }

    const change = applyVars(store, { CHANGE: 'new', NEW: 'y', KEEP: 'x' })

    expect(change).toEqual({
      added: ['NEW'],
      updated: ['CHANGE'],
      unchanged: ['KEEP']
    })
    expect(store.vars).toEqual({ KEEP: 'x', CHANGE: 'new', NEW: 'y' })
  })
})
