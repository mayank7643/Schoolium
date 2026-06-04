import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import { Users, IndianRupee, BookOpen, TrendingUp } from 'lucide-react'
import Link from 'next/link'

export default async function DashboardPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('school_id')
    .eq('id', user.id)
    .single()

  const schoolId = profile?.school_id

  // Fetch all stats in parallel
  const [studentsRes, classesRes, feesRes] = await Promise.all([
    supabase
      .from('students')
      .select('id', { count: 'exact' })
      .eq('school_id', schoolId)
      .eq('is_active', true),
    supabase
      .from('classes')
      .select('id', { count: 'exact' })
      .eq('school_id', schoolId),
    supabase
      .from('fees')
      .select('amount, status')
      .eq('school_id', schoolId),
  ])

  const totalStudents = studentsRes.count ?? 0
  const totalClasses = classesRes.count ?? 0

  const fees = feesRes.data ?? []
  const totalCollected = fees
    .filter((f) => f.status === 'paid')
    .reduce((sum, f) => sum + Number(f.amount), 0)
  const totalPending = fees
    .filter((f) => f.status === 'pending' || f.status === 'overdue')
    .reduce((sum, f) => sum + Number(f.amount), 0)

  const stats = [
    {
      label: 'Total students',
      value: totalStudents,
      icon: Users,
      color: 'text-blue-600',
      bg: 'bg-blue-50',
      href: '/dashboard/students',
    },
    {
      label: 'Fees collected',
      value: `₹${totalCollected.toLocaleString('en-IN')}`,
      icon: IndianRupee,
      color: 'text-green-600',
      bg: 'bg-green-50',
      href: '/dashboard/fees',
    },
    {
      label: 'Fees pending',
      value: `₹${totalPending.toLocaleString('en-IN')}`,
      icon: TrendingUp,
      color: 'text-yellow-600',
      bg: 'bg-yellow-50',
      href: '/dashboard/fees',
    },
    {
      label: 'Classes',
      value: totalClasses,
      icon: BookOpen,
      color: 'text-purple-600',
      bg: 'bg-purple-50',
      href: '/dashboard/classes',
    },
  ]

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="text-slate-500 text-sm mt-1">
          {new Date().toLocaleDateString('en-IN', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map((stat) => {
          const Icon = stat.icon
          return (
            <Link key={stat.label} href={stat.href} className="stat-card hover:shadow-md transition-shadow">
              <div className={`w-9 h-9 rounded-lg ${stat.bg} flex items-center justify-center mb-3`}>
                <Icon size={18} className={stat.color} />
              </div>
              <p className="text-2xl font-bold text-slate-900">{stat.value}</p>
              <p className="text-xs text-slate-500">{stat.label}</p>
            </Link>
          )
        })}
      </div>

      {/* Quick actions */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-700 mb-4">Quick actions</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard/students/new" className="btn-primary text-sm">
            + Add student
          </Link>
          <Link href="/dashboard/fees" className="btn-secondary text-sm">
            Record payment
          </Link>
          <Link href="/dashboard/classes" className="btn-secondary text-sm">
            Manage classes
          </Link>
        </div>
      </div>
    </div>
  )
}
