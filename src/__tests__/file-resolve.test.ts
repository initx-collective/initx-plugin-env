/* eslint-disable no-template-curly-in-string -- 用例断言的就是字面量占位符 */
import type { StorageAdapter } from '../storage/types'
import type { StoreFile } from '../types'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { assertEnvLimit, assertInlineLimit, oversizedValues } from '../files/limits'
import { resolveStoreVars } from '../files/resolve'
import { parseStore } from '../store'

const encoder = new TextEncoder()

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function makeStore(vars: Record<string, string>, files: Record<string, { bytes: Uint8Array, encoding?: 'utf8' | 'base64' }>): StoreFile {
  return parseStore(JSON.stringify({
    schema: 1,
    vars,
    files: Object.fromEntries(Object.entries(files).map(([id, file]) => [id, {
      sha256: digest(file.bytes),
      bytes: file.bytes.byteLength,
      ...(file.encoding ? { encoding: file.encoding } : {})
    }]))
  }), 'demo')
}

function makeClient(files: Record<string, Uint8Array>, onRead?: (path: string, options?: { maxBytes?: number }) => void): StorageAdapter {
  return {
    capabilities: { read: true, list: true, write: true, delete: true, conditionalWrite: true, readBytes: true, writeBytes: true },
    read: vi.fn(),
    readBytes: vi.fn(async (path, options) => {
      onRead?.(path, options)
      const bytes = files[path]
      return bytes ? { bytes, version: 'v1' } : null
    }),
    list: vi.fn(async () => []),
    write: vi.fn(),
    writeBytes: vi.fn(),
    remove: vi.fn()
  }
}

const utf8Key = encoder.encode('-----BEGIN KEY-----\nline\n-----END KEY-----\n')

describe('resolveStoreVars', () => {
  it('解析 UTF-8 文件并标记需要强制引号的键', async () => {
    const store = makeStore({ KEY: '${file-key}', PLAIN: 'x' }, { key: { bytes: utf8Key } })
    const resolved = await resolveStoreVars(makeClient({ 'stores/_files/demo/key': utf8Key }), 'stores', 'demo', store)
    expect(resolved.vars).toEqual({ KEY: '-----BEGIN KEY-----\nline\n-----END KEY-----\n', PLAIN: 'x' })
    expect([...resolved.fileKeys]).toEqual(['KEY'])
  })

  it('保留文件内容里的 BOM', async () => {
    const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...encoder.encode('abc')])
    const store = makeStore({ A: '${file-a}' }, { a: { bytes } })
    const resolved = await resolveStoreVars(makeClient({ 'stores/_files/demo/a': bytes }), 'stores', 'demo', store)
    expect(resolved.vars.A).toBe('\uFEFFabc')
  })

  it('encoding: base64 注入 base64 文本', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255])
    const store = makeStore({ BIN: '${file-bin}' }, { bin: { bytes, encoding: 'base64' } })
    const resolved = await resolveStoreVars(makeClient({ 'stores/_files/demo/bin': bytes }), 'stores', 'demo', store)
    expect(resolved.vars.BIN).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('同一个 id 只下载一次', async () => {
    const reads: string[] = []
    const store = makeStore({ A: '${file-key}', B: '${file-key}' }, { key: { bytes: utf8Key } })
    const resolved = await resolveStoreVars(makeClient({ 'stores/_files/demo/key': utf8Key }, path => reads.push(path)), 'stores', 'demo', store)
    expect(reads).toEqual(['stores/_files/demo/key'])
    expect(resolved.vars.A).toBe(resolved.vars.B)
  })

  it('keys 过滤只解析指定的键', async () => {
    const reads: string[] = []
    const store = makeStore({ A: '${file-a}', B: '${file-b}' }, {
      a: { bytes: encoder.encode('a') },
      b: { bytes: encoder.encode('b') }
    })
    const resolved = await resolveStoreVars(makeClient({
      'stores/_files/demo/a': encoder.encode('a'),
      'stores/_files/demo/b': encoder.encode('b')
    }, path => reads.push(path)), 'stores', 'demo', store, { keys: ['A'] })
    expect(reads).toEqual(['stores/_files/demo/a'])
    expect(resolved.vars).toMatchObject({ A: 'a', B: '${file-b}' })
    expect([...resolved.fileKeys]).toEqual(['A'])
  })

  it('把单文件上限透传给适配器', async () => {
    let seen: number | undefined
    const store = makeStore({ A: '${file-a}' }, { a: { bytes: encoder.encode('a') } })
    await resolveStoreVars(makeClient({ 'stores/_files/demo/a': encoder.encode('a') }, (_path, options) => {
      seen = options?.maxBytes
    }), 'stores', 'demo', store, { maxBytes: 123 })
    expect(seen).toBe(123)
  })

  it.each([
    ['missing-file', {}],
    ['size-mismatch', { 'stores/_files/demo/a': encoder.encode('ab') }],
    ['checksum-mismatch', { 'stores/_files/demo/a': encoder.encode('b') }]
  ] as const)('失败类型 %s', async (code, files) => {
    const store = makeStore({ A: '${file-a}' }, { a: { bytes: encoder.encode('a') } })
    const error = await resolveStoreVars(makeClient(files), 'stores', 'demo', store).catch(error => error)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toContain('secret-value')
  })

  it('非法 UTF-8 提示改用 base64', async () => {
    const bytes = new Uint8Array([0xFF, 0xFE])
    const store = makeStore({ A: '${file-a}' }, { a: { bytes } })
    const error = await resolveStoreVars(makeClient({ 'stores/_files/demo/a': bytes }), 'stores', 'demo', store).catch(error => error)
    expect(error).toMatchObject({ code: 'invalid-utf8' })
    expect(String(error)).toContain('base64')
  })
})

describe('体积上限', () => {
  it('统计超限值且不打印值本身', () => {
    const oversized = oversizedValues({ SMALL: 'a', BIG: 'b'.repeat(20) }, 10)
    expect(oversized).toEqual([{ key: 'BIG', bytes: 20 }])
    expect(() => assertInlineLimit({ BIG: 'b'.repeat(1024 * 1024 + 1) }, 'demo')).toThrow(/1 MiB|字节/)
    expect(() => assertEnvLimit({ BIG: 'b'.repeat(32 * 1024 + 1) }, 'demo')).toThrow(/32768 字节/)
  })
})
