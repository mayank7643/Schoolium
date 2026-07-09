'use client'

// FILE: app/(dashboard)/dashboard/alerts/settings/page.tsx
//
// Alerts settings (chat21, blueprint sections 5, 8, 10). Admin only.
//   1. Pipeline switches - master gate, check-in/out toggle (the cost
//      lever that closes deals), absent cutoff, quiet hours.
//   2. Templates - human layer + per-channel approved artifacts with
//      var_map, category, approval state. Send-test-message: THE
//      onboarding moment.
//   3. Gateways - the credential vault, via /api/alerts/channels only.
//      The UI ever sees fingerprint last-6 + health. Never a secret.

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import {
  ArrowLeft, Save, Plus, Trash2, ShieldCheck, RefreshCw,
  Send, Sparkles, AlertTriangle, CheckCircle2,
} from 'lucide-react'

// ---- types -----------------------------------------------------------
interface SchoolSettings {
  id: string
  alerts_enabled: boolean
  checkout_alerts_enabled: boolean
  absent_cutoff_time: string | null
  quiet_hours_start: string
  quiet_hours_end: string
  stale_alert_minutes: number | null
}

interface ChannelTpl {
  id: string
  channel: string
  category: string
  provider_template_id: string | null
  var_map: Record<string, string>
  approval_status: string
}

interface Tpl {
  id: string
  key: string
  body: string
  channel_templates: ChannelTpl[]
}

interface GatewaySummary {
  id: string
  channel: string
  provider: string
  health: string
  last_verified_at: string | null
  balance_hint_paise: number | null
  secret_fingerprint_last6: string
}

const HEALTH_BADGE: Record<string, string> = {
  ok: 'badge-green', unverified: 'badge-yellow', low_balance: 'badge-yellow',
  auth_failed: 'badge-red', suspended: 'badge-red',
}

const APPROVAL_BADGE: Record<string, string> = {
  approved: 'badge-green', submitted: 'badge-yellow', draft: 'badge-blue',
  rejected: 'badge-red', paused: 'badge-yellow',
}

const PROVIDERS_BY_CHANNEL: Record<string, string[]> = {
  whatsapp: ['meta_cloud', 'generic_http', 'fake'],
  sms: ['msg91', 'generic_http', 'fake'],
  email: ['generic_http', 'fake'],
}

const SECRET_HINT: Record<string, string> = {
  meta_cloud: 'JSON: {"access_token":"EAAG...","app_secret":"..."} - System User token + app secret',
  msg91: 'Your MSG91 authkey',
  generic_http: 'Whatever your gateway expects - available as {{secret}} in config',
  fake: 'Anything (test provider - no real sends)',
}

const CONFIG_HINT: Record<string, string> = {
  meta_cloud: '{"phone_number_id":"1234567890"}',
  msg91: '{}',
  generic_http: '{"url":"https://...","method":"POST","headers":{"Authorization":"Bearer {{secret}}"},"body":{"to":"{{recipient}}"},"message_id_path":"data.id"}',
  fake: '{}',
}

export default function AlertsSettingsPage() {
  const [role, setRole] = useState('')
  const [school, setSchool] = useState<SchoolSettings | null>(null)
  const [templates, setTemplates] = useState<Tpl[]>([])
  const [gateways, setGateways] = useState<GatewaySummary[]>([])
  const [webhookToken, setWebhookToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  // gateway form
  const [gwChannel, setGwChannel] = useState('whatsapp')
  const [gwProvider, setGwProvider] = useState('meta_cloud')
  const [gwSecret, setGwSecret] = useState('')
  const [gwConfig, setGwConfig] = useState('')
  const [gwBusy, setGwBusy] = useState(false)

  // channel-template add form (per message template id)
  const [ctForm, setCtForm] = useState<Record<string, { channel: string; category: string; provider_template_id: string; var_map: string }>>({})
  const [testPhone, setTestPhone] = useState('')

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text })
    setTimeout(() => setMsg(null), 6000)
  }

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data: profile } = await supabase
      .from('profiles').select('role, school_id').eq('id', user.id).single()
    setRole(profile?.role ?? '')
    if (profile?.role !== 'school_admin') { setLoading(false); return }

    const [schoolRes, tplRes, gwRes] = await Promise.all([
      supabase
        .from('schools')
        .select('id, alerts_enabled, checkout_alerts_enabled, absent_cutoff_time, quiet_hours_start, quiet_hours_end, stale_alert_minutes')
        .eq('id', profile.school_id).single(),
      supabase
        .from('message_templates')
        .select('id, key, body, channel_templates(id, channel, category, provider_template_id, var_map, approval_status)')
        .order('key'),
      fetch('/api/alerts/channels').then((r) => r.json()),
    ])

    setSchool(schoolRes.data as SchoolSettings)
    setTemplates((tplRes.data as unknown as Tpl[]) || [])
    setGateways((gwRes.channels as GatewaySummary[]) || [])
    setWebhookToken((gwRes.webhook_token as string) || '')
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  // ---- 1. pipeline switches ------------------------------------------
  async function saveSchool() {
    if (!school) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('schools')
      .update({
        alerts_enabled: school.alerts_enabled,
        checkout_alerts_enabled: school.checkout_alerts_enabled,
        absent_cutoff_time: school.absent_cutoff_time || null,
        quiet_hours_start: school.quiet_hours_start,
        quiet_hours_end: school.quiet_hours_end,
        stale_alert_minutes: school.stale_alert_minutes,
      })
      .eq('id', school.id)
    setSaving(false)
    if (error) flash('err', error.message)
    else flash('ok', 'Settings saved')
  }

  // ---- 2. templates -----------------------------------------------------
  async function seedTemplates() {
    if (!school) return
    const supabase = createClient()
    const { error } = await supabase.rpc('seed_default_message_templates', { p_school_id: school.id })
    if (error) flash('err', error.message)
    else { flash('ok', 'Starter templates created'); void load() }
  }

  async function saveTemplateBody(t: Tpl) {
    const supabase = createClient()
    const { error } = await supabase.from('message_templates').update({ body: t.body }).eq('id', t.id)
    if (error) flash('err', error.message)
    else flash('ok', `'${t.key}' saved`)
  }

  async function saveChannelTpl(ct: ChannelTpl) {
    const supabase = createClient()
    const { error } = await supabase
      .from('channel_templates')
      .update({
        provider_template_id: ct.provider_template_id || null,
        approval_status: ct.approval_status,
        approved_at: ct.approval_status === 'approved' ? new Date().toISOString() : null,
      })
      .eq('id', ct.id)
    if (error) flash('err', error.message)
    else flash('ok', 'Channel template saved')
  }

  async function addChannelTpl(t: Tpl) {
    if (!school) return
    const f = ctForm[t.id]
    if (!f) return
    let varMap: Record<string, string>
    try { varMap = JSON.parse(f.var_map) } catch { flash('err', 'var_map must be valid JSON'); return }
    const supabase = createClient()
    const { error } = await supabase.from('channel_templates').insert({
      school_id: school.id, message_template_id: t.id, channel: f.channel,
      category: f.category, provider_template_id: f.provider_template_id || null,
      var_map: varMap, approval_status: 'draft',
    })
    if (error) flash('err', error.message)
    else { flash('ok', 'Channel template added as draft'); setCtForm((o) => ({ ...o, [t.id]: undefined as never })); void load() }
  }

  async function deleteChannelTpl(id: string) {
    const supabase = createClient()
    const { error } = await supabase.from('channel_templates').delete().eq('id', id)
    if (error) flash('err', error.message)
    else void load()
  }

  // THE MOMENT: the admin's own phone buzzes from their school's name.
  async function sendTest(ct: ChannelTpl) {
    const phone = testPhone.trim()
    if (!phone) { flash('err', 'Enter your phone number (or email) above first'); return }
    const supabase = createClient()
    const { data, error } = await supabase.rpc('send_test_message', {
      p_channel_template_id: ct.id, p_recipient: phone,
    })
    if (error) flash('err', error.message)
    else flash('ok', `Test message queued (#${data}). The worker sends it within a minute.`)
  }

  // ---- 3. gateways ------------------------------------------------------
  async function addGateway() {
    setGwBusy(true)
    let config: Record<string, unknown> = {}
    if (gwConfig.trim()) {
      try { config = JSON.parse(gwConfig) } catch { flash('err', 'Config must be valid JSON'); setGwBusy(false); return }
    }
    const res = await fetch('/api/alerts/channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upsert', channel: gwChannel, provider: gwProvider, config, secret: gwSecret }),
    })
    const body = await res.json()
    setGwBusy(false)
    if (!res.ok) { flash('err', body.error ?? 'Failed'); return }
    flash('ok', `Credential stored. Health: ${body.channel.health}${body.detail ? ` — ${body.detail}` : ''}`)
    setGwSecret(''); setGwConfig('')
    void load()
  }

  async function verifyGateway(id: string) {
    const res = await fetch('/api/alerts/channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify', id }),
    })
    const body = await res.json()
    if (!res.ok) flash('err', body.error ?? 'Verify failed')
    else flash(body.health === 'ok' ? 'ok' : 'err', `Health: ${body.health}${body.detail ? ` — ${body.detail}` : ''}`)
    void load()
  }

  async function deleteGateway(id: string) {
    const res = await fetch('/api/alerts/channels', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!res.ok) flash('err', 'Delete failed')
    else void load()
  }

  // ---- render -----------------------------------------------------------
  if (!loading && role !== 'school_admin') {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="card text-center py-12 text-sm text-slate-500">
          Gateway credentials and templates are managed by the school admin only.
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/dashboard/alerts" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ArrowLeft size={15} /> Back to Alerts
      </Link>
      <h1 className="text-xl font-bold text-slate-900 mb-6">Alerts settings</h1>

      {msg && (
        <div className={`card mb-4 border-l-4 text-sm flex items-center gap-2 ${
          msg.kind === 'ok' ? 'border-green-500 text-green-700' : 'border-red-500 text-red-700'
        }`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} {msg.text}
        </div>
      )}

      {loading || !school ? (
        <div className="card h-64 animate-pulse bg-slate-50" />
      ) : (
        <div className="space-y-6">
          {/* ---- 1. pipeline ---- */}
          <div className="card">
            <h2 className="text-sm font-semibold text-slate-800 mb-4">Pipeline</h2>
            <div className="space-y-4">
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <span className="text-sm text-slate-700">
                  <span className="font-medium">Alerts enabled</span>
                  <span className="block text-xs text-slate-400">Master switch. Off = scans recorded, nothing sent.</span>
                </span>
                <input
                  type="checkbox" className="w-4 h-4 accent-brand-600"
                  checked={school.alerts_enabled}
                  onChange={(e) => setSchool({ ...school, alerts_enabled: e.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <span className="text-sm text-slate-700">
                  <span className="font-medium">Check-out alerts</span>
                  <span className="block text-xs text-slate-400">Check-in only halves your messaging bill.</span>
                </span>
                <input
                  type="checkbox" className="w-4 h-4 accent-brand-600"
                  checked={school.checkout_alerts_enabled}
                  onChange={(e) => setSchool({ ...school, checkout_alerts_enabled: e.target.checked })}
                />
              </label>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="label">Absence cutoff time (blank = off)</label>
                  <input
                    type="time" className="input"
                    value={school.absent_cutoff_time?.slice(0, 5) ?? ''}
                    onChange={(e) => setSchool({ ...school, absent_cutoff_time: e.target.value || null })}
                  />
                  <p className="text-xs text-slate-400 mt-1">Parents of unscanned students get an alert after this time.</p>
                </div>
                <div>
                  <label className="label">Suppress stale scans after (minutes, blank = never)</label>
                  <input
                    type="number" min={5} className="input"
                    value={school.stale_alert_minutes ?? ''}
                    onChange={(e) => setSchool({ ...school, stale_alert_minutes: e.target.value ? Number(e.target.value) : null })}
                  />
                </div>
                <div>
                  <label className="label">Quiet hours start</label>
                  <input
                    type="time" className="input" value={school.quiet_hours_start.slice(0, 5)}
                    onChange={(e) => setSchool({ ...school, quiet_hours_start: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Quiet hours end</label>
                  <input
                    type="time" className="input" value={school.quiet_hours_end.slice(0, 5)}
                    onChange={(e) => setSchool({ ...school, quiet_hours_end: e.target.value })}
                  />
                </div>
              </div>
              <button onClick={() => void saveSchool()} disabled={saving} className="btn-primary flex items-center gap-1.5">
                <Save size={14} /> {saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </div>

          {/* ---- 2. templates ---- */}
          <div className="card">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-slate-800">Message templates</h2>
              <button onClick={() => void seedTemplates()} className="btn-secondary flex items-center gap-1.5 text-xs">
                <Sparkles size={13} /> Create starter templates
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              The human-readable layer. Each needs an APPROVED per-channel artifact (DLT template id / Meta
              template name) before anything sends. Category is set at creation — utility is ~7.5x cheaper
              than marketing on WhatsApp.
            </p>

            <div className="mb-4">
              <label className="label">Test recipient (your phone in E.164, e.g. +919876543210)</label>
              <input className="input max-w-xs" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="+91…" />
            </div>

            {templates.length === 0 && (
              <p className="text-sm text-slate-400 py-4 text-center">No templates yet — create the starter set above.</p>
            )}

            <div className="space-y-4">
              {templates.map((t) => (
                <div key={t.id} className="rounded-xl border border-slate-100 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{t.key}</span>
                  </div>
                  <div className="flex gap-2 mb-3">
                    <input
                      className="input flex-1"
                      value={t.body}
                      onChange={(e) => setTemplates((old) => old.map((x) => x.id === t.id ? { ...x, body: e.target.value } : x))}
                    />
                    <button onClick={() => void saveTemplateBody(t)} className="btn-secondary text-xs shrink-0">Save</button>
                  </div>

                  {t.channel_templates.map((ct) => (
                    <div key={ct.id} className="flex flex-wrap items-center gap-2 py-2 border-t border-slate-50 text-sm">
                      <span className="capitalize text-slate-600 w-20">{ct.channel}</span>
                      <span className={ct.category === 'marketing' ? 'badge-yellow' : 'badge-blue'}>{ct.category}</span>
                      <input
                        className="input !py-1 text-xs flex-1 min-w-32"
                        placeholder="DLT template id / Meta template name"
                        value={ct.provider_template_id ?? ''}
                        onChange={(e) => setTemplates((old) => old.map((x) => x.id === t.id
                          ? { ...x, channel_templates: x.channel_templates.map((c) => c.id === ct.id ? { ...c, provider_template_id: e.target.value } : c) }
                          : x))}
                      />
                      <select
                        className="input !py-1 text-xs w-28"
                        value={ct.approval_status}
                        onChange={(e) => setTemplates((old) => old.map((x) => x.id === t.id
                          ? { ...x, channel_templates: x.channel_templates.map((c) => c.id === ct.id ? { ...c, approval_status: e.target.value } : c) }
                          : x))}
                      >
                        {['draft', 'submitted', 'approved', 'rejected', 'paused'].map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <span className={APPROVAL_BADGE[ct.approval_status] ?? 'badge-blue'}>{ct.approval_status}</span>
                      <button onClick={() => void saveChannelTpl(ct)} className="btn-secondary !py-1 text-xs">Save</button>
                      {ct.approval_status === 'approved' && (
                        <button onClick={() => void sendTest(ct)} className="btn-secondary !py-1 text-xs flex items-center gap-1">
                          <Send size={11} /> Test
                        </button>
                      )}
                      <button onClick={() => void deleteChannelTpl(ct.id)} className="text-slate-300 hover:text-red-500">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}

                  {/* add channel template */}
                  {ctForm[t.id] ? (
                    <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-50">
                      <select className="input !py-1 text-xs w-28" value={ctForm[t.id].channel}
                        onChange={(e) => setCtForm((o) => ({ ...o, [t.id]: { ...o[t.id], channel: e.target.value } }))}>
                        {['whatsapp', 'sms', 'email'].map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <select className="input !py-1 text-xs w-32" value={ctForm[t.id].category}
                        onChange={(e) => setCtForm((o) => ({ ...o, [t.id]: { ...o[t.id], category: e.target.value } }))}>
                        {['utility', 'transactional', 'service', 'marketing'].map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input className="input !py-1 text-xs flex-1 min-w-32" placeholder="provider template id"
                        value={ctForm[t.id].provider_template_id}
                        onChange={(e) => setCtForm((o) => ({ ...o, [t.id]: { ...o[t.id], provider_template_id: e.target.value } }))} />
                      <input className="input !py-1 text-xs flex-1 min-w-40 font-mono" placeholder='var_map JSON'
                        value={ctForm[t.id].var_map}
                        onChange={(e) => setCtForm((o) => ({ ...o, [t.id]: { ...o[t.id], var_map: e.target.value } }))} />
                      <button onClick={() => void addChannelTpl(t)} className="btn-primary !py-1 text-xs">Add</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setCtForm((o) => ({
                        ...o,
                        [t.id]: { channel: 'whatsapp', category: 'utility', provider_template_id: '', var_map: '{"1":"child","2":"school","3":"time"}' },
                      }))}
                      className="mt-2 text-xs text-brand-600 font-medium flex items-center gap-1"
                    >
                      <Plus size={12} /> Add channel
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* ---- 3. gateways (the vault) ---- */}
          <div className="card">
            <h2 className="text-sm font-semibold text-slate-800 mb-1 flex items-center gap-1.5">
              <ShieldCheck size={15} className="text-brand-600" /> Your gateways
            </h2>
            <p className="text-xs text-slate-400 mb-4">
              Your own WhatsApp Business / DLT SMS credentials. Encrypted at rest; this screen only ever
              shows the fingerprint. You pay Meta / your SMS operator directly, at cost.
            </p>

            {gateways.map((g) => (
              <div key={g.id} className="flex flex-wrap items-center gap-3 py-2.5 border-t border-slate-50 text-sm">
                <span className="capitalize font-medium text-slate-700 w-20">{g.channel}</span>
                <span className="text-slate-500">{g.provider}</span>
                <span className={HEALTH_BADGE[g.health] ?? 'badge-yellow'}>{g.health}</span>
                <span className="font-mono text-xs text-slate-400">…{g.secret_fingerprint_last6}</span>
                {g.balance_hint_paise != null && (
                  <span className="text-xs text-slate-500">bal ~Rs {(g.balance_hint_paise / 100).toFixed(0)}</span>
                )}
                {g.last_verified_at && (
                  <span className="text-xs text-slate-400">
                    verified {new Date(g.last_verified_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  <button onClick={() => void verifyGateway(g.id)} className="btn-secondary !py-1 text-xs flex items-center gap-1">
                    <RefreshCw size={11} /> Verify
                  </button>
                  <button onClick={() => void deleteGateway(g.id)} className="text-slate-300 hover:text-red-500">
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))}

            {/* add / rotate */}
            <div className="mt-4 pt-4 border-t border-slate-100 grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Channel</label>
                <select className="input" value={gwChannel}
                  onChange={(e) => { setGwChannel(e.target.value); setGwProvider(PROVIDERS_BY_CHANNEL[e.target.value][0]) }}>
                  {['whatsapp', 'sms', 'email'].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Provider</label>
                <select className="input" value={gwProvider} onChange={(e) => setGwProvider(e.target.value)}>
                  {(PROVIDERS_BY_CHANNEL[gwChannel] || []).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="label">Credential (stored encrypted, shown never again)</label>
                <textarea className="input font-mono text-xs" rows={2} value={gwSecret}
                  onChange={(e) => setGwSecret(e.target.value)} placeholder={SECRET_HINT[gwProvider]} />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Config (non-secret JSON)</label>
                <textarea className="input font-mono text-xs" rows={2} value={gwConfig}
                  onChange={(e) => setGwConfig(e.target.value)} placeholder={CONFIG_HINT[gwProvider]} />
              </div>
              <div className="sm:col-span-2">
                <button onClick={() => void addGateway()} disabled={gwBusy || !gwSecret.trim()}
                  className="btn-primary flex items-center gap-1.5 disabled:opacity-50">
                  <ShieldCheck size={14} /> {gwBusy ? 'Verifying…' : 'Verify & store credential'}
                </button>
                <p className="text-xs text-slate-400 mt-2">
                  Re-submitting the same channel + provider rotates the credential: it is re-verified before
                  it replaces the old one.
                </p>
              </div>
            </div>

            {/* webhook URL */}
            {school && webhookToken && (
              <div className="mt-4 pt-4 border-t border-slate-100">
                <p className="text-xs font-medium text-slate-500 mb-1">Delivery receipt webhook (paste into your gateway)</p>
                <code className="block text-xs bg-slate-50 rounded-lg p-2 break-all text-slate-600">
                  {typeof window !== 'undefined' ? window.location.origin : ''}/api/webhooks/{gwProvider}/{school.id}
                  {gwProvider === 'meta_cloud' ? `  (verify token: ${webhookToken})` : `?token=${webhookToken}`}
                </code>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
