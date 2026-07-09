// FILE: app/lib/alerts/vault.ts
//
// Credential vault crypto for the BYOG alerts pipeline (chat21).
//
// The school_channels table stores AES-256-GCM ciphertext only. The key
// lives HERE, in the worker process env (ALERTS_VAULT_KEY) - never in
// Postgres, so a database dump alone is useless. Plaintext secrets must
// never leave this process: never in a response body, a log line, or a
// Sentry breadcrumb.
//
// Server-only module. Never import from client components.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12

export interface EncryptedSecret {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  fingerprint: string // sha256 hex of plaintext - change detection only
}

function vaultKey(): Buffer {
  const raw = process.env.ALERTS_VAULT_KEY
  if (!raw) throw new Error('ALERTS_VAULT_KEY is not set')
  // Accept base64 or hex; must decode to exactly 32 bytes.
  const buf =
    /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw new Error('ALERTS_VAULT_KEY must decode to 32 bytes (hex or base64)')
  }
  return buf
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, vaultKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    fingerprint: createHash('sha256').update(plaintext, 'utf8').digest('hex'),
  }
}

export function decryptSecret(args: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): string {
  const decipher = createDecipheriv(ALGO, vaultKey(), args.iv)
  decipher.setAuthTag(args.tag)
  return Buffer.concat([decipher.update(args.ciphertext), decipher.final()]).toString('utf8')
}

// PostgREST serialises bytea as '\x<hex>'.
export function byteaToBuffer(v: string): Buffer {
  return Buffer.from(v.startsWith('\\x') ? v.slice(2) : v, 'hex')
}

export function bufferToBytea(buf: Buffer): string {
  return '\\x' + buf.toString('hex')
}

// Per-school HMAC token embedded in webhook URLs for providers that do
// not sign their callbacks (?token=...). Meta signs with the app secret
// instead (X-Hub-Signature-256), verified in the webhook route.
export function webhookToken(schoolId: string): string {
  const secret = process.env.ALERTS_WEBHOOK_SECRET
  if (!secret) throw new Error('ALERTS_WEBHOOK_SECRET is not set')
  return createHmac('sha256', secret).update(schoolId).digest('hex').slice(0, 32)
}

export function verifyWebhookToken(schoolId: string, token: string | null): boolean {
  if (!token) return false
  const expected = Buffer.from(webhookToken(schoolId))
  const given = Buffer.from(token)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

// Meta webhook signature: 'sha256=<hmac of raw body with the app secret>'.
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  const given = header.slice('sha256='.length)
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}
