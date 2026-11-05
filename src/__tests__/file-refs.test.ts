/* eslint-disable no-template-curly-in-string -- 这些用例断言的就是字面量占位符 */
import { describe, expect, it } from 'vitest'
import { storeFilesPath } from '../files/paths'
import { assertDeclaredRefs, collectVarFileRefs, FileRefError, formatFileRef, keysReferencing, parseFileRef, slugifyFileId } from '../files/refs'
import { parseStore, serializeStore } from '../store'
import { isValidFileId } from '../types'

const sha = 'a'.repeat(64)

function storeJson(files: unknown, vars: Record<string, string> = { A: '${file-a}' }): string {
  return JSON.stringify({ schema: 1, vars, files })
}

describe('文件引用语法', () => {
  it('只接受整值匹配，不做任何插值', () => {
    expect(parseFileRef('${file-deploy-key}')).toBe('deploy-key')
    expect(parseFileRef('${file-a.b_c-1}')).toBe('a.b_c-1')
    for (const value of [
      '${file-}',
      '${file-A}',
      '${file--a}',
      '${file-.a}',
      'prefix${file-a}',
      '${file-a}suffix',
      '${FILE-a}',
      '${file-a/b}',
      '${file-${x}}',
      '${file-a} ',
      ' ${file-a}'
    ])
      expect(parseFileRef(value), value).toBeNull()
  })

  it('生成引用前校验 id', () => {
    expect(formatFileRef('deploy-key')).toBe('${file-deploy-key}')
    expect(() => formatFileRef('Deploy_Key')).toThrow(FileRefError)
    expect(isValidFileId('a')).toBe(true)
    expect(isValidFileId('a.b_c-1')).toBe(true)
    for (const id of ['', 'A', '-a', '.a', 'a/b', 'a'.repeat(65)])
      expect(isValidFileId(id), id).toBe(false)
  })

  it('slug 覆盖常见变量名，且拒绝推不出字符的名字', () => {
    expect(slugifyFileId('DEPLOY_KEY')).toBe('deploy-key')
    expect(slugifyFileId('IOS_P12')).toBe('ios-p12')
    expect(slugifyFileId('SA_JSON')).toBe('sa-json')
    expect(slugifyFileId('A__B')).toBe('a-b')
    expect(slugifyFileId('A'.repeat(80))).toBe('a'.repeat(64))
    for (const key of ['___', '---', ''])
      expect(() => slugifyFileId(key), key).toThrow(FileRefError)
  })
})

describe('文件对象路径', () => {
  it('固定为 <path>/_files/<store>/<id>', () => {
    expect(storeFilesPath('stores', 'demo', 'deploy-key')).toBe('stores/_files/demo/deploy-key')
    expect(storeFilesPath('', 'demo', 'deploy-key')).toBe('_files/demo/deploy-key')
    expect(storeFilesPath('/stores/', 'demo', 'deploy-key')).toBe('stores/_files/demo/deploy-key')
  })

  it('拒绝不安全的 id 与目录', () => {
    expect(() => storeFilesPath('stores', 'demo', '../x')).toThrow(FileRefError)
    expect(() => storeFilesPath('stores', '../demo', 'a')).toThrow()
    expect(() => storeFilesPath('stores', 'demo', 'a\nb')).toThrow(FileRefError)
  })
})

describe('store 的 files 字段', () => {
  it('接受合法元数据并补默认 encoding', () => {
    const store = parseStore(storeJson({ a: { sha256: sha, bytes: 12 } }), 'demo')
    expect(store.files).toEqual({ a: { sha256: sha, bytes: 12, encoding: 'utf8' } })
  })

  it('拒绝非法 id、sha、字节数和 mode', () => {
    for (const files of [
      { Bad: { sha256: sha, bytes: 1 } },
      { a: { sha256: 'abc', bytes: 1 } },
      { a: { sha256: sha, bytes: -1 } },
      { a: { sha256: sha, bytes: 1.5 } },
      { a: { sha256: sha, bytes: 1, mode: '888' } },
      { a: { sha256: sha, bytes: 1, encoding: 'hex' } },
      { a: { sha256: sha, bytes: 1, extra: true } }
    ]) {
      expect(() => parseStore(storeJson(files), 'demo'), JSON.stringify(files)).toThrow(/files|结构不合法/)
    }
  })

  it('序列化往返保留 files', () => {
    const store = parseStore(storeJson({ a: { sha256: sha, bytes: 3, encoding: 'base64', mode: '600' } }), 'demo')
    expect(parseStore(serializeStore(store), 'demo')).toEqual(store)
  })

  it('没有 files 的旧 store 行为不变', () => {
    const store = parseStore(JSON.stringify({ schema: 1, vars: { A: '1' } }), 'demo')
    expect(store.files).toBeUndefined()
    expect(serializeStore(store)).toContain('"schema": 1')
  })
})

describe('引用与声明的一致性', () => {
  it('收集引用并支持反向查询', () => {
    const store = parseStore(storeJson({ a: { sha256: sha, bytes: 1 }, b: { sha256: sha, bytes: 1 } }, {
      A: '${file-a}',
      B: '${file-b}',
      C: 'plain'
    }), 'demo')
    expect(collectVarFileRefs(store)).toEqual([{ key: 'A', id: 'a' }, { key: 'B', id: 'b' }])
    expect(keysReferencing(store, 'a')).toEqual(['A'])
  })

  it('未声明的引用硬失败，且消息不含值以外的秘密', () => {
    const store = parseStore(JSON.stringify({ schema: 1, vars: { DEPLOY_KEY: '${file-deploy-ke}' } }), 'demo')
    const error = (() => {
      try {
        assertDeclaredRefs(store)
      }
      catch (error) {
        return error
      }
    })()
    expect(error).toBeInstanceOf(FileRefError)
    expect(error).toMatchObject({ code: 'unknown-ref' })
    expect(String(error)).toContain('DEPLOY_KEY')
    expect(String(error)).toContain('deploy-ke')
  })

  it('声明过的引用与非引用值都放行', () => {
    const store = parseStore(storeJson({ a: { sha256: sha, bytes: 1 } }, { A: '${file-a}', B: 'plain' }), 'demo')
    expect(() => assertDeclaredRefs(store)).not.toThrow()
  })
})
