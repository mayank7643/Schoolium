import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users, Plus, Search } from 'lucide-react'

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: { q?: string }
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('school_id')
    .eq('id', user.id)
    .single()

  const schoolId = profile?.school_id
  const query = searchParams.q ?? ''

  let studentsQuery = supabase
    .from('students')
    .select('*, classes(name, section)')
    .eq('school_id', schoolId)
    .eq('is_active', true)
    .order('full_name')

  if (query) {
    studentsQuery = studentsQuery.ilike('full_name', `%${query}%`)
  }

  const { data: students } = await studentsQuery

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Students</h1>
          <p className="text-slate-500 text-sm mt-1">
            {students?.length ?? 0} active students
          </p>
        </div>
        <Link href="/dashboard/students/new" className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={16} />
          Add student
        </Link>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <form>
          <input
            name="q"
            type="text"
            defaultValue={query}
            placeholder="Search students by name..."
            className="input pl-9"
          />
        </form>
      </div>

      {/* Students table */}
      {students && students.length > 0 ? (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Class</th>
                <th>Parent</th>
                <th>Phone</th>
                <th>Admission</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => (
                <tr key={student.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
                        <span className="text-brand-700 font-medium text-xs">
                          {student.full_name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <span className="font-medium text-slate-900">{student.full_name}</span>
                    </div>
                  </td>
                  <td>
                    {student.classes
                      ? `${student.classes.name}${student.classes.section ? ' - ' + student.classes.section : ''}`
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td>{student.parent_name ?? <span className="text-slate-400">—</span>}</td>
                  <td>{student.parent_phone ?? <span className="text-slate-400">—</span>}</td>
                  <td>
                    {student.admission_date
                      ? new Date(student.admission_date).toLocaleDateString('en-IN')
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td>
                    <Link
                      href={`/dashboard/students/${student.id}`}
                      className="text-brand-600 text-sm font-medium hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <Users size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">
            {query ? 'No students found' : 'No students yet'}
          </h3>
          <p className="text-sm text-slate-500 mb-4">
            {query
              ? `No results for "${query}"`
              : 'Add your first student to get started'}
          </p>
          {!query && (
            <Link href="/dashboard/students/new" className="btn-primary text-sm">
              + Add student
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
