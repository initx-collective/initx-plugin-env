import process from 'node:process'
import { logger } from '@initx-plugin/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { colorText, reportCommandError } from '../utils/terminal'

const originalExitCode = process.exitCode

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = originalExitCode
})

describe('terminal formatting', () => {
  it('uses the requested output stream to detect terminal color support', () => {
    vi.stubEnv('FORCE_COLOR', '')
    vi.stubEnv('NO_COLOR', undefined)
    vi.spyOn(process, 'stdout', 'get').mockReturnValue({ isTTY: true } as typeof process.stdout)
    vi.spyOn(process, 'stderr', 'get').mockReturnValue({ isTTY: false } as typeof process.stderr)
    expect(colorText('vault', 'blue')).toBe('\x1B[34mvault\x1B[0m')
    expect(colorText('failure', 'red', 'stderr')).toBe('failure')
  })

  it.each(['NO_COLOR', 'FORCE_COLOR'] as const)('respects %s when disabling colors', (key) => {
    vi.stubEnv('FORCE_COLOR', '1')
    vi.stubEnv('NO_COLOR', undefined)
    vi.stubEnv(key, key === 'NO_COLOR' ? '' : '0')
    expect(colorText('failure', 'red', 'stderr')).toBe('failure')
  })

  it('reports an unknown thrown value without inspecting or stringifying it', () => {
    vi.stubEnv('NO_COLOR', '1')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const toString = vi.fn(() => 'private token')
    reportCommandError({ secret: 'private token', toString })
    expect(error).toHaveBeenCalledExactlyOnceWith('命令执行失败')
    expect(toString).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
