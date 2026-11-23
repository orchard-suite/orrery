import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signJwt } from './git.ts'

describe('github app jwt', () => {
  it('signs RS256 tokens the API can verify', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
    const jwt = signJwt({ iss: '123', iat: 1, exp: 600 }, pem)
    const [h, p, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString()).iss).toBe('123')
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true)
  })
})
