import { sealSecret } from './crypto/sealed-box'
import { githubFetch } from './github'

/**
 * 把变量写进 GitHub Actions 的 secrets（REST API v2）。
 *
 * 流程是官方规定的三步，少一步都不行：
 *   1. GET  .../actions/secrets/public-key      → { key_id, key }
 *   2. 用 libsodium **sealed box** 加密值（见 src/crypto/sealed-box.ts）
 *   3. PUT  .../actions/secrets/{name}          body = { encrypted_value, key_id }
 *
 * ⚠️ 两个必须记住的事实：
 *   - secret 的值**只写不读**（GET 只返回 name/created_at/updated_at），
 *     所以永远不存在 "CI → 本地" 的同步方向；
 *   - 单条 secret 上限 48 KB，超了只能改用"密文进仓库 + 口令进 secret"的老办法。
 *
 * 写入刻意**串行**：`gh secret set -f` 是并发 PUT，中途失败既没有原子性也不好汇总。
 */

export interface SecretWriteOptions {
  /** 环境级 secret 的环境名；不传 = 仓库级 */
  env?: string | null
}

export type SecretWriteResult = 'created' | 'updated'

function secretsBase(repo: string, env?: string | null): string {
  const [owner, name] = repo.split('/', 2)
  const base = `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`

  return env
    ? `${base}/environments/${encodeURIComponent(env)}/secrets`
    : `${base}/actions/secrets`
}

export async function getPublicKey(
  repo: string,
  token: string,
  env?: string | null
): Promise<{ keyId: string, key: string }> {
  const res = await githubFetch(`${secretsBase(repo, env)}/public-key`, token)
  const data = await res.json() as { key_id?: string, key?: string }

  if (!data.key_id || !data.key)
    throw new Error(`拿不到 ${repo} 的公钥（返回体里没有 key_id/key）`)

  return { keyId: data.key_id, key: data.key }
}

export async function putSecret(
  repo: string,
  token: string,
  name: string,
  value: string,
  options: SecretWriteOptions = {}
): Promise<SecretWriteResult> {
  const { keyId, key } = await getPublicKey(repo, token, options.env)
  const encrypted = await sealSecret(key, value)

  const res = await githubFetch(
    `${secretsBase(repo, options.env)}/${encodeURIComponent(name)}`,
    token,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encrypted_value: encrypted, key_id: keyId })
    }
  )

  // 官方行为：201 = 新建，204 = 更新
  return res.status === 201 ? 'created' : 'updated'
}
