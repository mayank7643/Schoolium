'use client'

// FILE: app/(dashboard)/dashboard/alerts/platform/page.tsx
//
// Platform gateways (chat22) - super_admin only. These are Schoolium's
// OWN WhatsApp / SMS / email credentials, used by every school on
// managed mode. Same vault rules as the school gateways: verify before
// store, fingerprint + health only, paste-to-rotate. Managed by the
// /api/alerts/platform-channels service-role route.

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import {
  ArrowLeft, ShieldCheck, RefreshCw, Trash2, Eye, EyeOff, Pencil,
  AlertTriangle, CheckCircle2, Server,
} from 'lucide-react'
import type { PlatformChannelSummary } from '@/types'

interface Field {
  key: string; label: string; secret?: boolean; required?: boolean
  json?: boolean; placeholder?: string; help?: string
}

const PROVIDERS_BY_CHANNEL: Record<string, string[]> = {
  whatsapp: ['meta_cloud', 'generic_http', 'fake'],
  sms: ['msg91', 'generic_http', 'fake'],
  email: ['resend', 'generic_http', 'fake'],
}

const FIELDS: Record<string, Field[]> = {
  meta_cloud: [
    { key: 'access_token', label: 'Permanent access token', secret: true, required: true, placeholder: 'EAAG…' },
    { key: 'app_secret', label: 'App secret', secret: true, required: true, help: 'Verifies delivery webhooks' },
    { key: 'phone_number_id', label: 'Phone number ID', required: true },
    { key: 'waba_id', label: 'WABA ID', placeholder: 'optional' },
  ],
  msg91: [
    { key: 'authkey', label: 'MSG91 auth key', secret: true, required: true },
    { key: 'sender', label: 'Sender ID (DLT header)', placeholder: 'SCHOOL' },
  ],
  resend: [
    { key: 'api_key', label: 'Resend API key', secret: true, required: true, placeholder: 're_…' },
    { key: 'from', label: 'From address', required: true, placeholder: 'Schoolium Alerts <alerts@schoolium.app>', help: 'Must be a verified Resend sender' },
    { key: 'reply_to', label: 'Reply-to', placeholder: 'optional' },
  ],
  generic_http: [
    { key: 'api_key', label: 'API key / token', secret: true, required: true, help: 'Available as {{secret}} in headers/body' },
    { key: 'url', label: 'Send URL', required: true },
    { key: 'method', label: 'HTTP method', placeholder: 'POST' },
    { key: 'headers', label: 'Headers (JSON)', json: true, placeholder: '{"Authorization":"Bearer {{secret}}"}' },
    { key: 'body', label: 'Body template (JSON)', json: true, placeholder: '{"to":"{{recipient}}"}' },
    { key: 'message_id_path', label: 'Message-id path', placeholder: 'data.id' },
    { key: 'verify_url', label: 'Verify URL', placeholder: 'optional' },
  ],
  fake: [{ key: 'token', label: 'Any test value', secret: true, required: true, placeholder: 'test' }],
}

function buildSecret(provider: string, v: Record<string, string>): string {
  if (provider === 'meta_cloud') return JSON.stringify({ access_token: (v.access_token ?? '').trim(), app_secret: (v.app_secret ?? '').trim() })
  if (provider === 'msg91') return (v.authkey ?? '').trim()
  if (provider === 'resend' || provider === 'generic_http') return (v.api_key ?? '').trim()
  return (v.token ?? '').trim()
}

const HEALTH_BADGE: Record<string, string> = {
  ok: 'badge-green', unverified: 'badge-yellow', low_balance: 'badge-yellow',
  auth_failed: 'badge-red', suspended: 'badge-red',
}

export default function PlatformGatewaysPage() {
  const [role, setRole] = useState('')
  const [channels, setChannels] = useState<PlatformChannelSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const [gwChannel, setGwChannel] = useState('whatsapp')
  const [gwProvider, setGwProvider] = useState('meta_cloud')
  const [values, setValues] = useState<Record<string, string>>({})
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  const flash = (kind: 'ok' | 'err', text: string) => { setMsg({ kind, text }); setTimeout(() => setMsg(null), 6000) }

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
      setRole(profile?.role ?? '')
      if (profile?.role !== 'super_admin') return
      const res = await fetch('/api/alerts/platform-channels')
        .then(async (r) => (await r.json()) as { channels?: PlatformChannelSummary[]; error?: string })
        .catch(() => ({ channels: [], error: 'Could not reach the platform channels API' }))
      if (res.error) setLoadError(res.error)
      setChannels(res.channels || [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const existing = channels.find((c) => c.channel === gwChannel && c.provider === gwProvider) ?? null

  useEffect(() => {
    const init: Record<string, string> = {}
    const c = channels.find((x) => x.channel === gwChannel && x.provider === gwProvider)
    for (const f of FIELDS[gwProvider] ?? []) {
      if (f.secret) continue
      const val = (c?.config as Record<string, unknown> | undefined)?.[f.key]
      if (val === undefined || val === null) continue
      init[f.key] = typeof val === 'string' ? val : JSON.stringify(val)
    }
    setValues(init)
    setShowSecret({})
  }, [gwChannel, gwProvider, channels])

  async function save() {
    const spec = FIELDS[gwProvider] ?? []
    const secretSpec = spec.filter((f) => f.secret)
    const filled = secretSpec.filter((f) => (values[f.key] ?? '').trim())
    const requiredSecrets = secretSpec.filter((f) => f.required)
    if (!existing && filled.length < requiredSecrets.length) { flash('err', 'Fill in all credential fields'); return }
    if (existing && filled.length > 0 && filled.length < requiredSecrets.length) {
      flash('err', 'When replacing the credential, fill all secret fields together'); return
    }
    const config: Record<string, unknown> = {}
    for (const f of spec) {
      if (f.secret) continue
      const raw = (values[f.key] ?? '').trim()
      if (f.required && !raw) { flash('err', `${f.label} is required`); return }
      if (!raw) continue
      if (f.json) { try { config[f.key] = JSON.parse(raw) } catch { flash('err', `${f.label} must be valid JSON`); return } }
      else config[f.key] = raw
    }
    const secret = filled.length ? buildSecret(gwProvider, values) : ''
    setBusy(true)
    const res = await fetch('/api/alerts/platform-channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upsert', channel: gwChannel, provider: gwProvider, config, secret }),
    })
    const body = await res.json().catch(() => ({ error: 'Non-JSON error' }))
    setBusy(false)
    if (!res.ok) { flash('err', body.error ?? 'Failed'); return }
    flash('ok', `${secret ? 'Stored' : 'Updated'}. Health: ${body.channel.health}${body.detail ? ` — ${body.detail}` : ''}`)
    setValues((old) => { const n = { ...old }; for (const f of secretSpec) delete n[f.key]; return n })
    void load()
  }

  async function verify(id: string) {
    const res = await fetch('/api/alerts/platform-channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'verify', id }),
    })
    const body = await res.json().catch(() => ({ error: 'Non-JSON error' }))
    if (!res.ok) flash('err', body.error ?? 'Verify failed')
    else flash(body.health === 'ok' ? 'ok' : 'err', `Health: ${body.health}${body.detail ? ` — ${body.detail}` : ''}`)
    void load()
  }

  async function toggleActive(c: PlatformChannelSummary) {
    const res = await fetch('/api/alerts/platform-channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upsert', channel: c.channel, provider: c.provider, is_active: !c.is_active }),
    })
    if (!res.ok) { const b = await res.json().catch(() => ({})); flash('err', b.error ?? 'Failed') }
    void load()
  }

  async function remove(id: string) {
    const res = await fetch('/api/alerts/platform-channels', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    })
    if (!res.ok) flash('err', 'Delete failed')
    else void load()
  }

  if (!loading && role !== 'super_admin') {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="card text-center py-12 text-sm text-slate-500">
          Platform gateways are managed by Schoolium platform admins only.
        </div>
      </div>
    )
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/dashboard/alerts" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ArrowLeft size={15} /> Back to Alerts
      </Link>
      <h1 className="text-xl font-bold text-slate-900 mb-1 flex items-center gap-2">
        <Server size={19} className="text-brand-600" /> Platform gateways
      </h1>
      <p className="text-sm text-slate-500 mb-6">
        Schoolium&apos;s own WhatsApp / SMS / email credentials. Used by every school set to
        &ldquo;Schoolium-managed&rdquo; for that channel. Billed to those schools at managed rates.
      </p>

      {msg && (
        <div className={`card mb-4 border-l-4 text-sm flex items-center gap-2 ${msg.kind === 'ok' ? 'border-green-500 text-green-700' : 'border-red-500 text-red-700'}`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} {msg.text}
        </div>
      )}

      {loadError ? (
        <div className="card border-l-4 border-red-500 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {loadError}
        </div>
      ) : loading ? (
        <div className="card h-64 animate-pulse bg-slate-50" />
      ) : (
        <div className="card">
          {channels.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 py-2.5 border-t border-slate-50 first:border-0 text-sm">
              <span className="capitalize font-medium text-slate-700 w-20">{c.channel}</span>
              <span className="text-slate-500">{c.provider}</span>
              <span className={HEALTH_BADGE[c.health] ?? 'badge-yellow'}>{c.health}</span>
              {!c.is_active && <span className="badge-red">disabled</span>}
              <span className="font-mono text-xs text-slate-400">…{c.secret_fingerprint_last6}</span>
              <span className="ml-auto flex items-center gap-2">
                <button onClick={() => void verify(c.id)} className="btn-secondary !py-1 text-xs flex items-center gap-1"><RefreshCw size={11} /> Verify</button>
                <button onClick={() => void toggleActive(c)} className="btn-secondary !py-1 text-xs">{c.is_active ? 'Disable' : 'Enable'}</button>
                <button onClick={() => { setGwChannel(c.channel); setGwProvider(c.provider) }} className="btn-secondary !py-1 text-xs flex items-center gap-1"><Pencil size={11} /> Edit</button>
                <button onClick={() => void remove(c.id)} className="text-slate-300 hover:text-red-500"><Trash2 size={14} /></button>
              </span>
            </div>
          ))}

          <div className="mt-4 pt-4 border-t border-slate-100">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Channel</label>
                <select className="input" value={gwChannel} onChange={(e) => { setGwChannel(e.target.value); setGwProvider(PROVIDERS_BY_CHANNEL[e.target.value][0]) }}>
                  {['whatsapp', 'sms', 'email'].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Provider</label>
                <select className="input" value={gwProvider} onChange={(e) => setGwProvider(e.target.value)}>
                  {(PROVIDERS_BY_CHANNEL[gwChannel] || []).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            {existing && (
              <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mt-3">
                A credential is saved <span className="font-mono">(…{existing.secret_fingerprint_last6})</span>.
                Leave secret fields blank to keep it, or paste new values to replace.
              </p>
            )}

            <div className="grid sm:grid-cols-2 gap-3 mt-3">
              {(FIELDS[gwProvider] ?? []).map((f) => (
                <div key={f.key} className={f.json ? 'sm:col-span-2' : ''}>
                  <label className="label">{f.label}{f.required && !existing ? ' *' : ''}</label>
                  {f.secret ? (
                    <div className="relative">
                      <input
                        type={showSecret[f.key] ? 'text' : 'password'}
                        className="input pr-10 font-mono text-xs"
                        value={values[f.key] ?? ''}
                        onChange={(e) => setValues((o) => ({ ...o, [f.key]: e.target.value }))}
                        placeholder={existing ? '•••••• saved — paste to replace' : f.placeholder}
                        autoComplete="new-password" spellCheck={false}
                      />
                      <button type="button" onClick={() => setShowSecret((o) => ({ ...o, [f.key]: !o[f.key] }))}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" tabIndex={-1}>
                        {showSecret[f.key] ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  ) : f.json ? (
                    <textarea className="input font-mono text-xs" rows={2} value={values[f.key] ?? ''}
                      onChange={(e) => setValues((o) => ({ ...o, [f.key]: e.target.value }))} placeholder={f.placeholder} spellCheck={false} />
                  ) : (
                    <input className="input" value={values[f.key] ?? ''}
                      onChange={(e) => setValues((o) => ({ ...o, [f.key]: e.target.value }))} placeholder={f.placeholder} spellCheck={false} />
                  )}
                  {f.help && <p className="text-xs text-slate-400 mt-1">{f.help}</p>}
                </div>
              ))}
            </div>

            <div className="mt-4">
              <button onClick={() => void save()} disabled={busy} className="btn-primary flex items-center gap-1.5 disabled:opacity-50">
                <ShieldCheck size={14} /> {busy ? 'Verifying…' : existing ? 'Verify & update' : 'Verify & save'}
              </button>
            </div>

            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-xs font-medium text-slate-500 mb-1">Managed delivery webhook (configure once at the provider)</p>
              <code className="block text-xs bg-slate-50 rounded-lg p-2 break-all text-slate-600">
                {origin}/api/webhooks/platform/{gwProvider}
              </code>
              <p className="text-xs text-slate-400 mt-1">
                Get the URL token from <span className="font-mono">PUT /api/webhooks/platform/{gwProvider}</span> with the worker bearer secret.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
