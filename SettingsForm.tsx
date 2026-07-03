'use client'

// FILE: app/(dashboard)/dashboard/settings/SettingsForm.tsx
// Client form for school settings. Saves directly to the schools row via the
// browser Supabase client (RLS policy users_update_own_school permits it).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { Bell, MessageCircle, FileCheck, Clock, Percent, IndianRupee, Loader2, Check, AlertCircle, KeyRound } from 'lucide-react'

interface SchoolSettings {
  id: string
  name: string
  wa_alerts_enabled: boolean
  wa_fee_reminders_enabled: boolean
  wa_payment_confirmation_enabled: boolean
  fee_reminder_days_before: number
  wa_monthly_quota: number
  wa_messages_sent_month: number
  late_fee_waiver_max_pct: number
  late_fee_waiver_max_flat: number
}

function Toggle({
  checked, onChange, disabled,
}: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${
        checked ? 'bg-brand-600' : 'bg-slate-200'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-150 ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

function ToggleRow({
  icon: Icon, title, desc, checked, onChange,
}: { icon: React.ElementType; title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3.5">
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 w-8 h-8 rounded-lg bg-slate-50 flex items-center justify-center shrink-0">
          <Icon size={16} className="text-slate-500" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">{title}</p>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{desc}</p>
        </div>
      </div>
      <div className="pt-0.5"><Toggle checked={checked} onChange={onChange} /></div>
    </div>
  )
}

export default function SettingsForm({ school, hasOverridePin }: { school: SchoolSettings; hasOverridePin: boolean }) {
  const router = useRouter()

  const [waAlerts, setWaAlerts]       = useState(school.wa_alerts_enabled)
  const [feeReminders, setFeeReminders] = useState(school.wa_fee_reminders_enabled)
  const [payConfirm, setPayConfirm]   = useState(school.wa_payment_confirmation_enabled)
  const [daysBefore, setDaysBefore]   = useState(String(school.fee_reminder_days_before ?? 3))
  const [waiverPct, setWaiverPct]     = useState(String(school.late_fee_waiver_max_pct ?? 10))
  const [waiverFlat, setWaiverFlat]   = useState(String(school.late_fee_waiver_max_flat ?? 200))

  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  // Override PIN (never fetched to the client - we only know whether one is set)
  const [pinSet, setPinSet]       = useState(hasOverridePin)
  const [pinNew, setPinNew]       = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [pinSaving, setPinSaving] = useState(false)
  const [pinMsg, setPinMsg]       = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  async function handleSave() {
    setMsg(null)

    const days = parseInt(daysBefore, 10)
    const pct = parseFloat(waiverPct)
    const flat = parseFloat(waiverFlat)

    if (isNaN(days) || days < 1 || days > 30) {
      setMsg({ type: 'err', text: 'Reminder lead time must be between 1 and 30 days.' }); return
    }
    if (isNaN(pct) || pct < 0 || pct > 100) {
      setMsg({ type: 'err', text: 'Waiver percentage must be between 0 and 100.' }); return
    }
    if (isNaN(flat) || flat < 0) {
      setMsg({ type: 'err', text: 'Waiver flat cap must be zero or more.' }); return
    }

    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('schools')
      .update({
        wa_alerts_enabled: waAlerts,
        wa_fee_reminders_enabled: feeReminders,
        wa_payment_confirmation_enabled: payConfirm,
        fee_reminder_days_before: days,
        late_fee_waiver_max_pct: pct,
        late_fee_waiver_max_flat: flat,
      })
      .eq('id', school.id)
    setSaving(false)

    if (error) {
      setMsg({ type: 'err', text: `Could not save: ${error.message}` })
    } else {
      setMsg({ type: 'ok', text: 'Settings saved.' })
      router.refresh()
    }
  }

  async function handleSavePin() {
    setPinMsg(null)
    if (!/^[0-9]{4,6}$/.test(pinNew)) {
      setPinMsg({ type: 'err', text: 'PIN must be 4 to 6 digits.' }); return
    }
    if (pinNew !== pinConfirm) {
      setPinMsg({ type: 'err', text: 'The two PINs do not match.' }); return
    }
    setPinSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('set_admin_override_pin', { p_pin: pinNew })
    setPinSaving(false)
    if (error) {
      setPinMsg({ type: 'err', text: `Could not set PIN: ${error.message}` })
    } else {
      setPinMsg({ type: 'ok', text: 'Override PIN saved.' })
      setPinSet(true); setPinNew(''); setPinConfirm('')
      router.refresh()
    }
  }

  async function handleClearPin() {
    setPinMsg(null)
    setPinSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('set_admin_override_pin', { p_pin: null })
    setPinSaving(false)
    if (error) {
      setPinMsg({ type: 'err', text: `Could not remove PIN: ${error.message}` })
    } else {
      setPinMsg({ type: 'ok', text: 'Override PIN removed.' })
      setPinSet(false); setPinNew(''); setPinConfirm('')
      router.refresh()
    }
  }

  const quotaLeft = Math.max(school.wa_monthly_quota - school.wa_messages_sent_month, 0)

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">{school.name}</p>
      </div>

      {/* WhatsApp notifications */}
      <div className="card">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-slate-800">WhatsApp Notifications</h2>
          <span className="text-xs text-slate-400">
            {quotaLeft.toLocaleString('en-IN')} of {school.wa_monthly_quota.toLocaleString('en-IN')} left this month
          </span>
        </div>
        <p className="text-xs text-slate-500 mb-1">
          Each feature is independent. Turning one on does not affect the others.
        </p>
        <div className="divide-y divide-slate-100">
          <ToggleRow
            icon={Bell}
            title="Attendance alerts"
            desc="Entry, exit and absence messages to parents when a student is scanned."
            checked={waAlerts}
            onChange={setWaAlerts}
          />
          <ToggleRow
            icon={MessageCircle}
            title="Fee reminders"
            desc="Automatic reminders a few days before a fee is due, and weekly once it is overdue."
            checked={feeReminders}
            onChange={setFeeReminders}
          />
          <ToggleRow
            icon={FileCheck}
            title="Payment confirmation"
            desc="On every fee payment, send the parent a WhatsApp confirmation with the PDF receipt attached."
            checked={payConfirm}
            onChange={setPayConfirm}
          />
        </div>
      </div>

      {/* Reminder timing */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">Fee Reminder Timing</h2>
        <div className="flex items-end gap-3">
          <div className="flex-1 max-w-[200px]">
            <label className="label flex items-center gap-1.5">
              <Clock size={13} className="text-slate-400" /> Remind this many days before due
            </label>
            <input
              type="number" min={1} max={30}
              className="input"
              value={daysBefore}
              onChange={e => setDaysBefore(e.target.value)}
              disabled={!feeReminders}
            />
          </div>
        </div>
        {!feeReminders && (
          <p className="text-xs text-slate-400 mt-2">Turn on fee reminders above to use this.</p>
        )}
      </div>

      {/* Late-fee waiver caps */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-800 mb-1">Late-Fee Waiver Caps</h2>
        <p className="text-xs text-slate-500 mb-3">
          The most a collector can waive without an admin override. The effective cap is the smaller of the two.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label flex items-center gap-1.5">
              <Percent size={13} className="text-slate-400" /> Max % of late fee
            </label>
            <input
              type="number" min={0} max={100} step={0.5}
              className="input"
              value={waiverPct}
              onChange={e => setWaiverPct(e.target.value)}
            />
          </div>
          <div>
            <label className="label flex items-center gap-1.5">
              <IndianRupee size={13} className="text-slate-400" /> Max flat amount
            </label>
            <input
              type="number" min={0} step={1}
              className="input"
              value={waiverFlat}
              onChange={e => setWaiverFlat(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Admin override PIN */}
      <div className="card">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound size={15} className="text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-800">Admin Override PIN</h2>
          {pinSet
            ? <span className="badge-green ml-1">Set</span>
            : <span className="badge-yellow ml-1">Not set</span>}
        </div>
        <p className="text-xs text-slate-500 mb-3">
          Required to waive a late fee above the caps above. Stored securely (hashed) - it is never shown again.
        </p>
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <div>
            <label className="label">{pinSet ? 'New PIN' : 'PIN'} (4-6 digits)</label>
            <input
              type="password" inputMode="numeric" maxLength={6}
              className="input" value={pinNew}
              onChange={e => setPinNew(e.target.value.replace(/\D/g, ''))}
              placeholder="Enter PIN"
            />
          </div>
          <div>
            <label className="label">Confirm PIN</label>
            <input
              type="password" inputMode="numeric" maxLength={6}
              className="input" value={pinConfirm}
              onChange={e => setPinConfirm(e.target.value.replace(/\D/g, ''))}
              placeholder="Re-enter PIN"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <button className="btn-primary flex items-center gap-2" onClick={handleSavePin} disabled={pinSaving}>
            {pinSaving
              ? <><Loader2 size={15} className="animate-spin" /> Saving...</>
              : <><KeyRound size={15} /> {pinSet ? 'Update PIN' : 'Set PIN'}</>}
          </button>
          {pinSet && (
            <button className="btn-secondary" onClick={handleClearPin} disabled={pinSaving}>
              Remove PIN
            </button>
          )}
          {pinMsg && (
            <span className={`text-sm flex items-center gap-1.5 ${pinMsg.type === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
              {pinMsg.type === 'ok' ? <Check size={14} /> : <AlertCircle size={14} />}
              {pinMsg.text}
            </span>
          )}
        </div>
      </div>

      {/* Save bar */}
      <div className="flex items-center gap-3">
        <button className="btn-primary flex items-center gap-2" onClick={handleSave} disabled={saving}>
          {saving ? <><Loader2 size={15} className="animate-spin" /> Saving...</> : <><Check size={15} /> Save changes</>}
        </button>
        {msg && (
          <span className={`text-sm flex items-center gap-1.5 ${msg.type === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
            {msg.type === 'ok' ? <Check size={14} /> : <AlertCircle size={14} />}
            {msg.text}
          </span>
        )}
      </div>
    </div>
  )
}
