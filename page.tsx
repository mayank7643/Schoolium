// FILE: app/(dashboard)/dashboard/settings/page.tsx
//
// School settings (school_admin only). Self-serve controls that previously
// required editing Supabase directly:
//   - WhatsApp feature gates (attendance alerts, fee reminders, payment
//     confirmation) + reminder lead time
//   - Late-fee waiver caps
//
// The admin override PIN is intentionally NOT edited here - it needs to be
// hashed (bcrypt) before it is set from the UI; that is a separate secure step.

import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import SettingsForm from './SettingsForm'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, school_id, is_active')
    .eq('id', user.id)
    .single()

  if (!profile || !profile.is_active || profile.role !== 'school_admin') {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Settings</h1>
          <p className="text-sm text-slate-500">
            Only a school admin can view and change these settings.
          </p>
        </div>
      </div>
    )
  }

  const { data: school, error } = await supabase
    .from('schools')
    .select(
      'id, name, wa_alerts_enabled, wa_fee_reminders_enabled, wa_payment_confirmation_enabled, ' +
      'fee_reminder_days_before, wa_monthly_quota, wa_messages_sent_month, ' +
      'late_fee_waiver_max_pct, late_fee_waiver_max_flat'
    )
    .eq('id', profile.school_id)
    .single()

  if (error || !school) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Settings</h1>
          <p className="text-sm text-red-600">Could not load your school settings. Please try again.</p>
        </div>
      </div>
    )
  }

  return <SettingsForm school={school as any} />
}
