import { EventEmitter } from 'node:events'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { child, spawn } = vi.hoisted(() => ({ child: { current: undefined as any }, spawn: vi.fn() }))
vi.mock('cross-spawn', () => ({ default: spawn }))

afterEach(() => vi.useRealTimers())

describe('跨平台宽限逻辑（包括 Windows 上不具备的可忽略 POSIX 信号）', () => {
  it('只转发一次，5 秒后 SIGKILL，并移除监听器', async () => {
    vi.useFakeTimers()
    child.current = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(), unref: vi.fn() })
    spawn.mockReturnValue(child.current)
    const { runProcess } = await import('../utils/run-process')
    const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))
    const result = runProcess('fixture', ['a b'], {})
    process.emit('SIGTERM')
    process.emit('SIGINT')
    expect(child.current.kill.mock.calls).toEqual([['SIGTERM']])
    await vi.advanceTimersByTimeAsync(4999)
    expect(child.current.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.current.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(await result).toMatchObject({ signal: 'SIGTERM' })
    expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(before)
    expect(spawn).toHaveBeenCalledWith('fixture', ['a b'], { env: {}, stdio: 'inherit', shell: false })
  })
})
