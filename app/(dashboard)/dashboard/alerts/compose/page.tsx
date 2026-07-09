'use client'

// FILE: app/(dashboard)/dashboard/alerts/compose/page.tsx
//
// Announcement composer (chat21, blueprint section 8). Schools cannot
// free-type messages: they pick an APPROVED channel template and fill
// variables - TRAI and Meta do not permit arbitrary content, and that
// constraint is the product. The confirm screen shows recipient count,
// resolved preview, estimated cost incl GST, and channel/category
// badges BEFORE the send button goes live.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import { ArrowLeft, Send, Users, IndianRupee, RefreshCw, CheckCircle2 } from 'lucide-react'
import type { NoticeDeliveryStats, PublishNoticeResult } from '@/types'

interface TemplateOption {
  id: string
  key: string
  body: string
  channels: { channel: string; category: string }[]
}

// Vars the pipeline fills automatically from the event context.
const AUTO_VARS = new Set(['child', 'child_first', 'school', 'class', 'time', 'date'])

function extractVars(body: string): string[] {
  const found = new Set<string>()
  const re = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const name = m[1].toLowerCase()
    if (!AUTO_VARS.has(name)) found.add(name)
  }
  return Array.from(found)
}

function paise(n: number): string {
  return `Rs ${(n / 100).toFixed(2)}`
}

export default function ComposeNoticePage() {
  const [role, setRole] = useState('')
  const [schoolName, setSchoolName] = useState('')
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [classLabels, setClassLabels] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  const [templateId, setTemplateId] = useState('')
  const [classLabel, setClassLabel] = useState('')
  const [vars, setVars] = useState<Record<string, string>>({})

  const [estimate, setEstimate] = useState<{ recipients: number; cost: number } | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState('')

  const [published, setPublished] = useState<PublishNoticeResult | null>(null)
  const [stats, setStats] = useState<NoticeDeliveryStats | null>(null)

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: profile } = await supabase
        .from('profiles').select('role, school_id, schools(name)').eq('id', user.id).single()
      setRole(profile?.role ?? '')
      const school = profile?.schools as { name: string } | { name: string }[] | null
      setSchoolName(Array.isArray(school) ? school[0]?.name ?? '' : school?.name ?? '')

      // Approved channel templates joined onto their human templates.
      const { data: mts, error: mtErr } = await supabase
        .from('message_templates')
        .select('id, key, body, channel_templates(channel, category, approval_status)')
        .order('key')
      const options: TemplateOption[] = ((mts as unknown as Array<{
        id: string; key: string; body: string
        channel_templates: { channel: string; category: string; approval_status: string }[] | null
      }>) || [])
        .map((t) => ({
          id: t.id,
          key: t.key,
          body: t.body,
          channels: (t.channel_templates || [])
            .filter((c) => c.approval_status === 'approved')
            .map((c) => ({ channel: c.channel, category: c.category })),
        }))
        .filter((t) => t.channels.length > 0)
      setTemplates(options)
      if (mtErr) {
        setError(
          /does not exist|schema cache/i.test(mtErr.message)
            ? 'The alerts schema is not in this database yet. Run "Migration sql/chat21_alerts_byog_foundation.sql" in the Supabase SQL editor. (' + mtErr.message + ')'
            : mtErr.message,
        )
      }

      const { data: students } = await supabase
        .from('students').select('class_label').eq('is_active', true).not('class_label', 'is', null)
      const labels = Array.from(
        new Set(((students as { class_label: string | null }[]) || []).map((s) => s.class_label).filter(Boolean) as string[]),
      ).sort()
      setClassLabels(labels)
      setLoading(false)
    }
    void load()
  }, [])

  const selected = useMemo(() => templates.find((t) => t.id === templateId) ?? null, [templates, templateId])
  const customVars = useMemo(() => (selected ? extractVars(selected.body) : []), [selected])

  const preview = useMemo(() => {
    if (!selected) return ''
    return selected.body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, raw: string) => {
      const name = raw.toLowerCase()
      if (name === 'school') return schoolName || 'Your School'
      if (name === 'class') return classLabel || 'all classes'
      if (name === 'date') return new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      if (name === 'time') return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
      if (AUTO_VARS.has(name)) return `[${name}]`
      return vars[name] || `[${name}]`
    })
  }, [selected, schoolName, classLabel, vars])

  const refreshEstimate = useCallback(async () => {
    if (!templateId) return
    setEstimating(true)
    setError('')
    const supabase = createClient()
    const { data, error: err } = await supabase.rpc('estimate_notice_send', {
      p_message_template_id: templateId,
      p_class_label: classLabel || null,
    })
    setEstimating(false)
    if (err) { setError(err.message); return }
    const row = (data as { recipient_count: number; est_cost_paise: number }[])?.[0]
    if (row) setEstimate({ recipients: row.recipient_count, cost: row.est_cost_paise })
  }, [templateId, classLabel])

  useEffect(() => {
    setEstimate(null)
    if (templateId) void refreshEstimate()
  }, [templateId, classLabel, refreshEstimate])

  async function refreshStats(eventId: number) {
    const supabase = createClient()
    const { data } = await supabase.rpc('get_notice_delivery_stats', { p_event_id: eventId })
    const row = (data as NoticeDeliveryStats[])?.[0]
    if (row) setStats(row)
  }

  async function publish() {
    if (!selected) return
    const missing = customVars.filter((v) => !vars[v]?.trim())
    if (missing.length) { setError(`Fill in: ${missing.join(', ')}`); return }
    setPublishing(true)
    setError('')
    const supabase = createClient()
    const { data, error: err } = await supabase.rpc('publish_notice', {
      p_message_template_id: selected.id,
      p_vars: vars,
      p_class_label: classLabel || null,
    })
    setPublishing(false)
    if (err) { setError(err.message); return }
    const result = data as unknown as PublishNoticeResult
    setPublished(result)
    void refreshStats(result.event_id)
  }

  const canCompose = role === 'school_admin' || role === 'operator' || role === 'super_admin'

  if (!loading && !canCompose) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="card text-center py-12 text-sm text-slate-500">
          Only the school admin or an operator can send notices.
        </div>
      </div>
    )
  }

  // ---- post-publish: live delivery stats -------------------------
  if (published) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link href="/dashboard/alerts" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft size={15} /> Back to Alerts
        </Link>
        <div className="card text-center py-10">
          <CheckCircle2 size={36} className="text-green-600 mx-auto mb-3" />
          <h1 className="text-lg font-bold text-slate-900">Notice queued for {published.queued} guardians</h1>
          <p className="text-sm text-slate-500 mt-1">The worker sends within seconds. Watch it land:</p>

          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 max-w-xl mx-auto">
              <div className="stat-card"><p className="text-xs text-slate-500">Queued</p><p className="text-xl font-bold text-slate-900">{stats.n_queued}</p></div>
              <div className="stat-card"><p className="text-xs text-slate-500">Sent</p><p className="text-xl font-bold text-blue-700">{stats.n_sent}</p></div>
              <div className="stat-card"><p className="text-xs text-slate-500">Delivered</p><p className="text-xl font-bold text-green-700">{stats.n_delivered}</p></div>
              <div className="stat-card"><p className="text-xs text-slate-500">Read</p><p className="text-xl font-bold text-green-700">{stats.n_read}</p></div>
            </div>
          )}

          <div className="flex items-center justify-center gap-2 mt-6">
            <button onClick={() => void refreshStats(published.event_id)} className="btn-secondary flex items-center gap-1.5">
              <RefreshCw size={14} /> Refresh
            </button>
            <button
              onClick={() => { setPublished(null); setStats(null); setVars({}); setClassLabel('') }}
              className="btn-primary"
            >
              Send another
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ---- composer ----------------------------------------------------
  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/dashboard/alerts" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ArrowLeft size={15} /> Back to Alerts
      </Link>
      <h1 className="text-xl font-bold text-slate-900 mb-1">Send a notice</h1>
      <p className="text-sm text-slate-500 mb-6">
        Pick an approved template and fill in the blanks. One message per guardian, however many children they have.
      </p>

      {loading ? (
        <div className="card h-64 animate-pulse bg-slate-50" />
      ) : templates.length === 0 ? (
        <div className="card text-center py-12 text-sm text-slate-500">
          {error && <p className="text-red-600 mb-2">{error}</p>}
          No approved templates yet. Ask your school admin to set them up in{' '}
          <Link href="/dashboard/alerts/settings" className="text-brand-600 font-medium">Alerts settings</Link>.
        </div>
      ) : (
        <div className="card space-y-5">
          {/* Template */}
          <div>
            <label className="label">Template</label>
            <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Choose a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.key} — {t.body.slice(0, 60)}</option>
              ))}
            </select>
            {selected && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {selected.channels.map((c) => (
                  <span key={c.channel} className={c.category === 'marketing' ? 'badge-yellow' : 'badge-blue'}>
                    {c.channel} · {c.category}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Audience */}
          <div>
            <label className="label">Audience</label>
            <select className="input" value={classLabel} onChange={(e) => setClassLabel(e.target.value)}>
              <option value="">All classes</option>
              {classLabels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Custom variables */}
          {customVars.map((v) => (
            <div key={v}>
              <label className="label capitalize">{v.replace(/_/g, ' ')}</label>
              <input
                className="input"
                value={vars[v] ?? ''}
                onChange={(e) => setVars((old) => ({ ...old, [v]: e.target.value }))}
                placeholder={`Enter ${v}…`}
              />
            </div>
          ))}

          {/* Confirm screen: preview + count + cost, before send is live */}
          {selected && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-medium text-slate-400 mb-1.5">Preview</p>
              <p className="text-sm text-slate-800 whitespace-pre-wrap">{preview}</p>
              <div className="flex flex-wrap items-center gap-4 mt-3 pt-3 border-t border-slate-200 text-sm">
                <span className="flex items-center gap-1.5 text-slate-600">
                  <Users size={14} className="text-slate-400" />
                  {estimating ? 'Counting…' : estimate ? `${estimate.recipients} guardians` : '—'}
                </span>
                <span className="flex items-center gap-1.5 text-slate-600">
                  <IndianRupee size={14} className="text-slate-400" />
                  {estimating ? '…' : estimate ? `${paise(estimate.cost)} est. (incl. GST)` : '—'}
                </span>
                <button onClick={() => void refreshEstimate()} className="text-xs text-brand-600 font-medium ml-auto">
                  Recalculate
                </button>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            onClick={() => void publish()}
            disabled={!selected || publishing || !estimate || estimate.recipients === 0}
            className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Send size={15} />
            {publishing
              ? 'Sending…'
              : estimate && selected
                ? `Send to ${estimate.recipients} guardians (${paise(estimate.cost)})`
                : 'Send'}
          </button>
        </div>
      )}
    </div>
  )
}
