/**
 * libsodium sealed box（匿名加密），用于 GitHub Actions secrets 写入 API。
 *
 * 为什么是 sealed box：
 * `PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}` 要求 `encrypted_value`
 * 是用 GET `.../actions/secrets/public-key` 返回的公钥（`key` 字段，base64）加密后的密文。
 * 这个加密必须是「匿名」的：发送方只拿得到仓库公钥，没有、也不该有对应私钥，
 * 所以只能用 `crypto_box_seal`（sealed box，内部基于 X25519 + XSalsa20-Poly1305），
 * 由 GitHub 侧用私钥解开。这正是 GitHub 官方文档里 Node.js 示例的做法。
 *
 * 为什么不用 tweetsodium：
 * tweetsodium 是 libsodium 的早期 JS 移植，已废弃（deprecated）且长期不维护，
 * WASM/JS 实现与 API 都落后于官方的 `libsodium-wrappers`（本文件用的这个）。
 * 官方 wrappers 体积更小、维护活跃，也是 GitHub 官方示例所用的库。
 *
 * base64 变体：GitHub 的 `key` 和我们要回传的 `encrypted_value` 都是
 * 「标准 base64（带 padding）」，对应 libsodium 的 `base64_variants.ORIGINAL`，
 * 因此本文件所有编解码都显式指定 ORIGINAL，不用 URLSAFE / URLSAFE_NO_PADDING。
 */
import sodium from 'libsodium-wrappers'

/** X25519 公钥固定 32 字节 */
const X25519_PUBLIC_KEY_BYTES = 32

/** 模块级缓存：libsodium WASM 只初始化一次 */
let sodiumPromise: Promise<typeof sodium> | undefined

/** 等 libsodium WASM 就绪；重复调用只初始化一次 */
export function loadSodium(): Promise<typeof sodium> {
  if (!sodiumPromise) {
    sodiumPromise = sodium.ready.then(() => sodium)
  }
  return sodiumPromise
}

/** 解码 GitHub 的公钥字段，并校验长度 */
function decodePublicKey(instance: typeof sodium, publicKeyBase64: string): Uint8Array {
  let publicKey: Uint8Array

  try {
    publicKey = instance.from_base64(publicKeyBase64.trim(), instance.base64_variants.ORIGINAL)
  }
  catch {
    throw new Error('GitHub 公钥解码失败：它不是合法的 base64（ORIGINAL 变体）字符串；请确认传入的是 public-key 接口返回的 key 字段，而不是 key_id')
  }

  if (publicKey.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new Error(
      `GitHub 公钥长度不正确：X25519 公钥必须是 ${X25519_PUBLIC_KEY_BYTES} 字节，实际 ${publicKey.length} 字节。`
      + ' 这种情况通常是 key_id 与 key 两个字段弄反了（或把 key_id 当成了公钥）；请改用 public-key 接口返回的 key 字段'
    )
  }

  return publicKey
}

/**
 * publicKeyBase64 = GitHub 的 GET .../actions/secrets/public-key 返回的 key 字段
 * 返回 base64（ORIGINAL 变体）的密文，直接可作为 encrypted_value 提交
 */
export async function sealSecret(publicKeyBase64: string, value: string): Promise<string> {
  const instance = await loadSodium()
  const publicKey = decodePublicKey(instance, publicKeyBase64)

  // 值按 UTF-8 编码，空字符串同样可以封（sealed box 只是消息长度为 0）
  const sealed = instance.crypto_box_seal(instance.from_string(value), publicKey)

  return instance.to_base64(sealed, instance.base64_variants.ORIGINAL)
}

/** 仅用于测试/自检：用私钥解开自己封的 box */
export async function openSealedBoxForTest(
  sealedBase64: string,
  publicKeyBase64: string,
  privateKeyBase64: string
): Promise<string> {
  const instance = await loadSodium()
  const sealed = instance.from_base64(sealedBase64, instance.base64_variants.ORIGINAL)
  const publicKey = instance.from_base64(publicKeyBase64, instance.base64_variants.ORIGINAL)
  const privateKey = instance.from_base64(privateKeyBase64, instance.base64_variants.ORIGINAL)

  const opened: Uint8Array | null = instance.crypto_box_seal_open(sealed, publicKey, privateKey)

  if (!opened) {
    throw new Error('sealed box 解密失败：密文、公钥、私钥不匹配')
  }

  return instance.to_string(opened)
}
