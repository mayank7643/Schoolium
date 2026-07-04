'use client'

// FILE: app/(dashboard)/dashboard/staff/[id]/StaffActions.tsx
//
// Admin/principal actions on a staff member (chat17):
//   - change employment status (set_staff_status RPC - SECURITY DEFINER,
//     also toggles the login; terminal statuses force the login off)
//   - reset the login password (/api/staff/reset-password Node route)

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { KeyRound, UserCog } from 'lucide-react'
import type { EmploymentStatus } from '@/types'

const STATUS_OPTIONS: { value: EmploymentStatus; label: string }[] = [
  { value: 'active',     label: 'Active' },
  { value: 'probation',  label: 'Probation' },
  { value: 'on_leave',   label: 'On leave' },
  { value: 'resigned',   label: 'Resigned' },
  { value: 'terminated', label: 'Terminated' },
  { value: 'retired',    label: 'Retired' },
]

const TERMINAL: EmploymentStatus[] = ['resigned', 'terminated', 'retired']

export default function StaffActions({
  staffId,
  currentStatus,
  staffName,
}: {
  staffId: string
  currentStatus: EmploymentStatus
  staffName: string
}) {
  const router = useRouter()

  const [status, setStatus]             = useState<EmploymentStatus>(currentStatus)
  const [savingStatus, setSavingStatus] = useState(false)
  const [statusMsg, setStatusMsg]       = useState('')
  const [statusErr, setStatusErr]       = useState('')

  const [newPassword, setNewPassword]   = useState('')
  const [resetting, setResetting]       = useState(false)
  const [resetMsg, setResetMsg]         = useState('')
  const [resetErr, setResetErr]         = useState('')

  async function saveStatus() {
    if (status === currentStatus) return
    if (TERMINAL.includes(status)) {
      const ok = window.confirm(
        `Set ${staffName} as ${status}? Their login will be deactivated immediately.`
      )
      if (!ok) { setStatus(currentStatus); return }
    }

    setSavingStatus(true)
    setStatusErr('')
    setStatusMsg('')

    const supabase = createClient()
    const { error } = await supabase.rpc('set_staff_status', {
      p_staff_id: staffId,
      p_status: status,
    })

    if (error) {
      setStatusErr(error.message)
      setStatus(currentStatus)
    } else {
      setStatusMsg('Status updated')
      router.refresh()
    }
    setSavingStatus(false)
  }

  async function resetPassword() {
    if (newPassword.length < 8) {
      setResetErr('Password must be at least 8 characters')
      return
    }
    setResetting(true)
    setResetErr('')
    setResetMsg('')

    try {
      const res = await fetch('/api/staff/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staff_id: staffId, new_password: newPassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResetErr(data.error ?? 'Failed to reset password')
      } else {
        setResetMsg('Password updated - share it with the staff member')
        setNewPassword('')
      }
    } catch {
      setResetErr('Network error - check your connection')
    }
    setResetting(false)
  }

  return (
    <div className="card flex flex-col gap-5">
      <h2 className="font-semibold text-slate-800">Manage</h2>

      {/* Employment status */}
      <div>
        <label className="label flex items-center gap-1.5">
          <UserCog size={14} className="text-slate-400" /> Employment status
        </label>
        <div className="flex gap-2">
          <select
            className="input flex-1"
            value={status}
            onChange={e => setStatus(e.target.value as EmploymentStatus)}
            disabled={savingStatus}
          >
            {STATUS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={saveStatus}
            disabled={savingStatus || status === currentStatus}
            className="btn-primary text-sm px-4 disabled:opacity-50"
          >
            {savingStatus ? 'Saving...' : 'Save'}
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-1.5">
          Resigned, terminated or retired also deactivates the login.
        </p>
        {statusMsg && <p className="text-xs text-green-600 mt-1">{statusMsg}</p>}
        {statusErr && <p className="text-xs text-red-500 mt-1">{statusErr}</p>}
      </div>

      {/* Password reset */}
      <div className="border-t border-slate-100 pt-4">
        <label className="label flex items-center gap-1.5">
          <KeyRound size={14} className="text-slate-400" /> Reset password
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            className="input flex-1"
            placeholder="New password (min 8 chars)"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            autoComplete="off"
          />
          <button
            onClick={resetPassword}
            disabled={resetting || newPassword.length < 8}
            className="btn-secondary text-sm px-4 disabled:opacity-50"
          >
            {resetting ? '...' : 'Reset'}
          </button>
        </div>
        {resetMsg && <p className="text-xs text-green-600 mt-1">{resetMsg}</p>}
        {resetErr && <p className="text-xs text-red-500 mt-1">{resetErr}</p>}
      </div>
    </div>
  )
}
