import { createClient } from '@/utils/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Phone, Mail, MapPin, Calendar } from 'lucide-react'

export default async function StudentDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: student } = await supabase
    .from('students')
    .select('*, classes(name, section)')
    .eq('id', params.id)
    .single()

  if (!student) notFound()

  const { data: fees } = await supabase
    .from('fees')
    .select('*')
    .eq('student_id', student.id)
    .order('created_at', { ascending: false })

  const totalPaid = fees
    ?.filter((f) => f.status === 'paid')
    .reduce((sum, f) => sum + Number(f.amount), 0) ?? 0

  const totalPending = fees
    ?.filter((f) => f.status === 'pending' || f.status === 'overdue')
    .reduce((sum, f) => sum + Number(f.amount), 0) ?? 0

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/dashboard/students"
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-slate-600" />
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Student profile</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Left — profile */}
        <div className="md:col-span-1">
          <div className="card flex flex-col items-center text-center">
            <div className="w-16 h-16 bg-brand-100 rounded-full flex items-center justify-center mb-3">
              <span className="text-brand-700 font-bold text-2xl">
                {student.full_name.charAt(0).toUpperCase()}
              </span>
            </div>
            <h2 className="font-semibold text-slate-900 text-lg">{student.full_name}</h2>
            <p className="text-sm text-slate-500 mb-1">
              {student.classes
                ? `${student.classes.name}${student.classes.section ? ' - ' + student.classes.section : ''}`
                : 'No class assigned'}
            </p>
            <span className={student.is_active ? 'badge-green' : 'badge-red'}>
              {student.is_active ? 'Active' : 'Inactive'}
            </span>

            <div className="w-full border-t border-slate-100 mt-4 pt-4 flex flex-col gap-2 text-sm text-slate-600 text-left">
              {student.parent_phone && (
                <div className="flex items-center gap-2">
                  <Phone size={14} className="text-slate-400" />
                  {student.parent_phone}
                </div>
              )}
              {student.parent_email && (
                <div className="flex items-center gap-2">
                  <Mail size={14} className="text-slate-400" />
                  {student.parent_email}
                </div>
              )}
              {student.address && (
                <div className="flex items-start gap-2">
                  <MapPin size={14} className="text-slate-400 mt-0.5 shrink-0" />
                  {student.address}
                </div>
              )}
              {student.admission_date && (
                <div className="flex items-center gap-2">
                  <Calendar size={14} className="text-slate-400" />
                  Admitted {new Date(student.admission_date).toLocaleDateString('en-IN')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right — fees summary */}
        <div className="md:col-span-2 flex flex-col gap-5">
          {/* Fee stats */}
          <div className="grid grid-cols-2 gap-4">
            <div className="stat-card">
              <p className="text-xs text-slate-500">Total paid</p>
              <p className="text-2xl font-bold text-green-600">
                ₹{totalPaid.toLocaleString('en-IN')}
              </p>
            </div>
            <div className="stat-card">
              <p className="text-xs text-slate-500">Pending</p>
              <p className="text-2xl font-bold text-yellow-600">
                ₹{totalPending.toLocaleString('en-IN')}
              </p>
            </div>
          </div>

          {/* Fee history */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-800">Fee history</h3>
              <Link href={`/dashboard/fees?student=${student.id}`} className="text-sm text-brand-600 hover:underline">
                Add fee
              </Link>
            </div>

            {fees && fees.length > 0 ? (
              <div className="flex flex-col gap-2">
                {fees.map((fee) => (
                  <div key={fee.id} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                    <div>
                      <p className="text-sm font-medium text-slate-800 capitalize">{fee.fee_type}</p>
                      <p className="text-xs text-slate-400">
                        {fee.paid_date
                          ? `Paid on ${new Date(fee.paid_date).toLocaleDateString('en-IN')}`
                          : fee.due_date
                          ? `Due ${new Date(fee.due_date).toLocaleDateString('en-IN')}`
                          : 'No due date'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-slate-900">
                        ₹{Number(fee.amount).toLocaleString('en-IN')}
                      </span>
                      <span className={
                        fee.status === 'paid' ? 'badge-green' :
                        fee.status === 'overdue' ? 'badge-red' : 'badge-yellow'
                      }>
                        {fee.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-400 text-center py-4">No fee records yet</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
