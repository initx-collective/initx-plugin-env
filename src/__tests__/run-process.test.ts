import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess, signalExitCode } from '../utils/run-process'
import { createHarness, fixtures, root, start, stop, waitForOutput } from './run-harness'

let harness: Awaited<ReturnType<typeof createHarness>>
const children: ReturnType<typeof start>[] = []

beforeEach(async () => harness = await createHarness())
afterEach(async () => {
  for (const running of children.splice(0)) {
    stop(running.child)
    await running.done
  }
  await harness.cleanup()
})

async function host(script: string) {
  const executor = join(harness.directory, 'executor.mjs')
  await build({ entryPoints: [join(root, 'src/utils/run-process.ts')], outfile: executor, bundle: true, platform: 'node', format: 'esm', banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } })
  harness.env.INITX_TEST_EXECUTOR = pathToFileURL(executor).href
  const running = start(process.execPath, [join(fixtures, 'process-host.mjs'), process.execPath, '-e', script], { env: harness.env, cwd: harness.directory }, process.platform === 'win32')
  children.push(running)
  return running
}

describe('真实进程生命周期及监听器清理', () => {
  it('正常与启动错误结束后，监听器数量恢复原值', async () => {
    const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))
    expect(await runProcess(process.execPath, ['-e', 'process.exitCode = 7'], process.env)).toEqual({ code: 7 })
    expect(await runProcess('initx-no-such-executable-112233', [], process.env)).toMatchObject({ code: 127, errorCode: 'ENOENT' })
    expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(before)
  })

  it.runIf(process.platform !== 'win32')('无执行权限返回 126（POSIX 文件权限）', async () => {
    const script = join(harness.directory, 'not-executable')
    await writeFile(script, '#!/bin/sh\nexit 0\n')
    await chmod(script, 0o600)
    expect(await runProcess(script, [], process.env)).toMatchObject({ code: 126, errorCode: 'EACCES' })
  })

  it.each(['SIGINT', 'SIGTERM'] as const)('转发 %s，非零结束并清理监听器（Windows 父信号事件由 IPC 触发）', async (signal) => {
    const script = `for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { process.stdout.write(signal + '\\n'); setTimeout(() => process.exit(0), 100) }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`
    const running = await host(script)
    await waitForOutput(running, 'ready')
    if (process.platform === 'win32')
      running.child.send!(signal)
    else
      running.child.kill(signal)
    const result = await running.done
    if (process.platform === 'win32') {
      expect(result.code).toBe(signalExitCode(signal))
    }
    else {
      expect(result.signal).toBe(signal)
      expect(result.stdout).toContain(signal)
    }
    const event = JSON.parse((await readFile(harness.env.INITX_TEST_EVENTS!, 'utf8')).trim())
    expect(event.after).toEqual(event.before)
    expect(event.result).toEqual({ code: signalExitCode(signal), signal })
  }, 15000)

  it.runIf(process.platform !== 'win32')('忽略信号的子进程在 5 秒宽限后终止；重复信号不会延长计时', async () => {
    const running = await host(`process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`)
    await waitForOutput(running, 'ready')
    const begin = Date.now()
    running.child.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(running.child.exitCode).toBe(null)
    running.child.kill('SIGINT')
    const result = await running.done
    expect(Date.now() - begin).toBeGreaterThanOrEqual(4900)
    expect(Date.now() - begin).toBeLessThan(10000)
    expect(result.signal).toBe('SIGTERM')
    const event = JSON.parse((await readFile(harness.env.INITX_TEST_EVENTS!, 'utf8')).trim())
    expect(event.after).toEqual(event.before)
  }, 15000)

  it.runIf(process.platform !== 'win32')('子进程自行被信号终止时，外层复现相同信号', async () => {
    const result = await (await host(`process.kill(process.pid, 'SIGTERM')`)).done
    expect(result.signal).toBe('SIGTERM')
  })
})
