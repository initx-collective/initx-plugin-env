import { describe, expect, it } from 'vitest'
import { loadSodium, openSealedBoxForTest, sealSecret } from '../crypto/sealed-box'

/**
 * `sealSecret` 的正确性只能本地自证：GitHub 的公钥拿不到（那要真仓库 + PAT）。
 * 用 libsodium 自己生成一对密钥，封了再用私钥解 —— 走通就说明
 * `crypto_box_seal` 的调用方式、base64 变体、UTF-8 编码都是对的。
 */
describe('sealed box', () => {
  it('round-trips values through crypto_box_seal / crypto_box_seal_open', async () => {
    const sodium = await loadSodium()
    const { publicKey, privateKey } = sodium.crypto_box_keypair()
    const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)
    const privateKeyBase64 = sodium.to_base64(privateKey, sodium.base64_variants.ORIGINAL)

    const values = [
      '',
      'short',
      'p@ss word with 空格 and emoji 🎊',
      'line1\nline2\nline3',
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
    ]

    for (const value of values) {
      const sealed = await sealSecret(publicKeyBase64, value)

      expect(sealed).toMatch(/^[A-Z0-9+/]+={0,2}$/i)
      expect(await openSealedBoxForTest(sealed, publicKeyBase64, privateKeyBase64)).toBe(value)
    }
  })

  it('seals the same value differently every time (ephemeral key)', async () => {
    const sodium = await loadSodium()
    const { publicKey } = sodium.crypto_box_keypair()
    const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)

    expect(await sealSecret(publicKeyBase64, 'x')).not.toBe(await sealSecret(publicKeyBase64, 'x'))
  })

  it('rejects a public key that is not 32 bytes', async () => {
    const sodium = await loadSodium()
    const wrong = sodium.to_base64(sodium.randombytes_buf(16), sodium.base64_variants.ORIGINAL)

    await expect(sealSecret(wrong, 'x')).rejects.toThrow(/32 字节/)
  })
})
