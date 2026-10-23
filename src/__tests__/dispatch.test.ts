import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import EnvPlugin from '../index'

/**
 * 用**真实的 matchinitx 匹配器**（通过 @initx-plugin/core 的 `plugin.run`）验证命令面。
 *
 * 这里复刻 initx CLI 的调用方式（`cli/runner.ts` 里构造 ctx 后调 `instance.run`），
 * 因为最容易出错的地方是「规则写错 → 命令静默不存在」：
 * matchinitx 对字符串是**精确相等**，`optional` 又是对第一个位置参数的白名单。
 */

const packageInfo = {
  root: process.cwd(),
  name: '@initx-plugin/env',
  version: '0.1.0',
  description: 'test',
  author: 'test',
  isLocal: true
}

function run(key: string, ...others: string[]) {
  const plugin = new EnvPlugin()

  return plugin.run(
    { key, cliOptions: {}, optionsList: [], packageInfo },
    ...others
  )
}

describe('命令分发（走真实匹配器）', () => {
  it('每个已声明的子命令都能命中恰好一个 handler', async () => {
    for (const action of ['list', 'pull', 'set', 'push', 'setup', 'apply', 'run']) {
      const handlers = await run('env', action)

      expect(handlers, `env ${action}`).toHaveLength(1)
    }
  })

  it('裸 `initx env` 命中（用于打帮助）', async () => {
    expect(await run('env')).toHaveLength(1)
  })

  it('未声明的子命令不命中任何 handler（不会误吃别的命令）', async () => {
    expect(await run('env', 'nope')).toHaveLength(0)
    expect(await run('envs')).toHaveLength(0)
    expect(await run('env', 'pull', 'extra')).toHaveLength(1)
  })

  it('env-config 与 env 互不串门', async () => {
    expect(await run('env-config', 'set')).toHaveLength(1)
    expect(await run('env-config', 'status')).toHaveLength(1)
    // `status` 只属于 env-config，不该落进 env
    expect(await run('env', 'status')).toHaveLength(0)
  })

  it('`env help` 命中唯一 handler', async () => {
    expect(await run('env', 'help')).toHaveLength(1)
  })
})

describe('构建产物', () => {
  const distEntry = resolve(process.cwd(), 'dist/index.mjs')

  it.skipIf(!existsSync(distEntry))('dist/index.mjs 的默认导出是可实例化的插件类', async () => {
    const mod = await import(/* @vite-ignore */ distEntry)
    const PluginClass = mod.default
    const instance = new PluginClass()

    expect(instance.rules.map((rule: { matching: string }) => rule.matching)).toEqual(['env', 'env-config'])
    expect(instance.defaultStore).toEqual({ branch: 'main', path: 'stores' })
  })
})
