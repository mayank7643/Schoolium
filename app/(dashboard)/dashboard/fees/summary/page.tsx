// app/(dashboard)/dashboard/fees/summary/page.tsx
// Server component — fetches all data, passes to client component
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import FeeSummaryClient from './FeeSummaryClient'

export default async function FeeSummaryPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('school_id, full_name')
    .eq('id', user.id)
    .single()

  const schoolId = profile?.school_id
  if (!schoolId) redirect('/dashboard')

  const { data: schoolData } = await supabase
    .from('schools')
    .select('name')
    .eq('id', schoolId)
    .single()

  const [classesRes, feesRes, studentsRes] = await Promise.all([
    supabase
      .from('classes')
      .select('id, name, section')
      .eq('school_id', schoolId)
      .order('name'),
    supabase
      .from('fees')
      .select('id, amount, status, fee_type, due_date, paid_date, created_at, student_id, students(id, full_name, student_uid, father_name, class_id)')
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false }),
    supabase
      .from('students')
      .select('id, class_id')
      .eq('school_id', schoolId)
      .eq('is_active', true),
  ])

  return (
    <FeeSummaryClient
      schoolName={schoolData?.name ?? 'School'}
      classes={classesRes.data ?? []}
      fees={(feesRes.data ?? []) as any}
      students={studentsRes.data ?? []}
    />
  )
}
