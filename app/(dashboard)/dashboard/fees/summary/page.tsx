import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, IndianRupee, AlertCircle, CheckCircle2, Clock } from 'lucide-react'

interface ClassSummary {
  classId: string
  className: string
  totalStudents: number
  collected: number
  pending: number
  overdue: number
  defaulters: { id: string; full_name: string; student_uid: string | null; amount: number; status: string }[]
}

function sortClassLabel(a: ClassSummary, b: ClassSummary): number {
  const aNum = parseInt(a.className), bNum = parseInt(b.className)
  const aIsNum = !isNaN(aNum), bIsNum = !isNaN(bNum)
  if (aIsNum && bIsNum) return aNum - bNum
  if (aIsNum) return -1
  if (bIsNum) return 1
  return a.className.localeCompare(b.className)
}

export default async function FeeSummaryPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('school_id')
    .eq('id', user.id)
    .single()

  const schoolId = profile?.school_id
  if (!schoolId) redirect('/dashboard')

  // Fetch classes + all fee records with student + class info in parallel
  const [classesRes, feesRes, studentsRes] = await Promise.all([
    supabase
      .from('classes')
      .select('id, name, section')
      .eq('school_id', schoolId)
      .order('name'),
    supabase
      .from('fees')
      .select('id, amount, status, student_id, students(id, full_name, student_uid, class_id)')
      .eq('school_id', schoolId),
    supabase
      .from('students')
      .select('id, class_id')
      .eq('school_id', schoolId)
      .eq('is_active', true),
  ])

  const classes = classesRes.data ?? []
  const fees = feesRes.data ?? []
  const students = studentsRes.data ?? []

  // Count students per class
  const studentCountByClass: Record<string, number> = {}
  students.forEach(s => {
    if (s.class_id) {
      studentCountByClass[s.class_id] = (studentCountByClass[s.class_id] ?? 0) + 1
    }
  })

  // Build summary per class
  const summaryMap: Record<string, ClassSummary> = {}

  classes.forEach(cls => {
    const label = `${cls.name}${cls.section ? ` — ${cls.section}` : ''}`
    summaryMap[cls.id] = {
      classId: cls.id,
      className: label,
      totalStudents: studentCountByClass[cls.id] ?? 0,
      collected: 0,
      pending: 0,
      overdue: 0,
      defaulters: [],
    }
  })

  // Aggregate fees into class buckets
  fees.forEach(fee => {
    const student = fee.students as any
    if (!student?.class_id || !summaryMap[student.class_id]) return
    const summary = summaryMap[student.class_id]
    const amount = Number(fee.amount)

    if (fee.status === 'paid') {
      summary.collected += amount
    } else if (fee.status === 'overdue') {
      summary.overdue += amount
      // Add to defaulters list (deduplicated by student, sum amounts)
      const existing = summary.defaulters.find(d => d.id === student.id)
      if (existing) {
        existing.amount += amount
      } else {
        summary.defaulters.push({
          id: student.id,
          full_name: student.full_name,
          student_uid: student.student_uid,
          amount,
          status: 'overdue',
        })
      }
    } else {
      summary.pending += amount
    }
  })

  const summaries = Object.values(summaryMap)
    .filter(s => s.collected > 0 || s.pending > 0 || s.overdue > 0 || s.totalStudents > 0)
    .sort(sortClassLabel)

  // Grand totals
  const grandCollected = summaries.reduce((s, c) => s + c.collected, 0)
  const grandPending   = summaries.reduce((s, c) => s + c.pending, 0)
  const grandOverdue   = summaries.reduce((s, c) => s + c.overdue, 0)
  const totalDefaulters = summaries.reduce((s, c) => s + c.defaulters.length, 0)

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/fees"
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
          >
            <ArrowLeft size={18} className="text-slate-600" />
          </Link>
          <div>
            <h1 className="text-xl lg:text-2xl font-bold text-slate-900">Fee summary by class</h1>
            <p className="text-slate-500 text-sm mt-0.5">Collected, pending and overdue across all classes</p>
          </div>
        </div>
      </div>

      {/* Grand totals */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="stat-card">
          <div className="w-8 h-8 bg-green-50 rounded-lg flex items-center justify-center mb-2">
            <CheckCircle2 size={16} className="text-green-600" />
          </div>
          <p className="text-xl font-bold text-green-600">₹{grandCollected.toLocaleString('en-IN')}</p>
          <p className="text-xs text-slate-500">Total collected</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-yellow-50 rounded-lg flex items-center justify-center mb-2">
            <Clock size={16} className="text-yellow-600" />
          </div>
          <p className="text-xl font-bold text-yellow-600">₹{grandPending.toLocaleString('en-IN')}</p>
          <p className="text-xs text-slate-500">Total pending</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-red-50 rounded-lg flex items-center justify-center mb-2">
            <AlertCircle size={16} className="text-red-600" />
          </div>
          <p className="text-xl font-bold text-red-600">₹{grandOverdue.toLocaleString('en-IN')}</p>
          <p className="text-xs text-slate-500">Total overdue</p>
        </div>
        <div className="stat-card">
          <div className="w-8 h-8 bg-orange-50 rounded-lg flex items-center justify-center mb-2">
            <IndianRupee size={16} className="text-orange-600" />
          </div>
          <p className="text-xl font-bold text-orange-600">{totalDefaulters}</p>
          <p className="text-xs text-slate-500">Defaulters</p>
        </div>
      </div>

      {/* Class breakdown */}
      {summaries.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <IndianRupee size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No fee records yet</h3>
          <p className="text-sm text-slate-500 mb-4">Record payments to see the class-wise breakdown here</p>
          <Link href="/dashboard/fees" className="btn-primary text-sm">Go to Fees</Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {summaries.map(cls => {
            const total = cls.collected + cls.pending + cls.overdue
            const collectedPct = total > 0 ? Math.round((cls.collected / total) * 100) : 0
            const pendingPct   = total > 0 ? Math.round((cls.pending / total) * 100) : 0
            const overduePct   = total > 0 ? Math.round((cls.overdue / total) * 100) : 0

            return (
              <div key={cls.classId} className="card p-0 overflow-hidden">
                {/* Class header row */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="w-1 h-5 bg-brand-600 rounded-full" />
                    <div>
                      <p className="font-semibold text-slate-900">{cls.className}</p>
                      <p className="text-xs text-slate-400">{cls.totalStudents} student{cls.totalStudents !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  {/* Collection rate badge */}
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                    collectedPct >= 80 ? 'bg-green-50 text-green-700' :
                    collectedPct >= 50 ? 'bg-yellow-50 text-yellow-700' :
                    'bg-red-50 text-red-700'
                  }`}>
                    {collectedPct}% collected
                  </span>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-3 divide-x divide-slate-100 px-0">
                  <div className="px-5 py-3">
                    <p className="text-xs text-slate-400 mb-0.5">Collected</p>
                    <p className="font-semibold text-green-600">₹{cls.collected.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="px-5 py-3">
                    <p className="text-xs text-slate-400 mb-0.5">Pending</p>
                    <p className="font-semibold text-yellow-600">₹{cls.pending.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="px-5 py-3">
                    <p className="text-xs text-slate-400 mb-0.5">Overdue</p>
                    <p className="font-semibold text-red-600">₹{cls.overdue.toLocaleString('en-IN')}</p>
                  </div>
                </div>

                {/* Progress bar — collected / pending / overdue */}
                {total > 0 && (
                  <div className="px-5 pb-3">
                    <div className="w-full h-1.5 rounded-full overflow-hidden bg-slate-100 flex">
                      {collectedPct > 0 && (
                        <div className="bg-green-400 h-full" style={{ width: `${collectedPct}%` }} />
                      )}
                      {pendingPct > 0 && (
                        <div className="bg-yellow-400 h-full" style={{ width: `${pendingPct}%` }} />
                      )}
                      {overduePct > 0 && (
                        <div className="bg-red-400 h-full" style={{ width: `${overduePct}%` }} />
                      )}
                    </div>
                  </div>
                )}

                {/* Defaulters list — only shown if overdue exists */}
                {cls.defaulters.length > 0 && (
                  <div className="border-t border-slate-100 px-5 py-3">
                    <p className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">
                      Overdue — {cls.defaulters.length} student{cls.defaulters.length !== 1 ? 's' : ''}
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {cls.defaulters
                        .sort((a, b) => b.amount - a.amount)
                        .map(d => (
                          <div key={d.id} className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {d.student_uid && (
                                <span className="font-mono text-[10px] bg-brand-50 text-brand-700 border border-brand-200 px-1.5 py-0.5 rounded">
                                  {d.student_uid}
                                </span>
                              )}
                              <Link
                                href={`/dashboard/students/${d.id}`}
                                className="text-sm text-slate-700 hover:text-brand-600 hover:underline"
                              >
                                {d.full_name}
                              </Link>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-red-600">
                                ₹{d.amount.toLocaleString('en-IN')}
                              </span>
                              <Link
                                href={`/dashboard/fees?student_uid=${d.student_uid ?? ''}`}
                                className="text-xs text-brand-600 hover:underline"
                              >
                                Record →
                              </Link>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
