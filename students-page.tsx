import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users, Plus, Search } from 'lucide-react'

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: { q?: string; class?: string }
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles').select('school_id').eq('id', user.id).single()

  const schoolId = profile?.school_id
  const query = searchParams.q ?? ''
  const classFilter = searchParams.class ?? ''

  // Fetch all classes for this school
  const { data: classes } = await supabase
    .from('classes')
    .select('*')
    .eq('school_id', schoolId)
    .order('name')

  // Fetch students
  let studentsQuery = supabase
    .from('students')
    .select('*, classes(id, name, section)')
    .eq('school_id', schoolId)
    .eq('is_active', true)
    .order('full_name')

  if (query) studentsQuery = studentsQuery.ilike('full_name', `%${query}%`)
  if (classFilter) studentsQuery = studentsQuery.eq('class_id', classFilter)

  const { data: students } = await studentsQuery

  // Group students by class
  const grouped: Record<string, typeof students> = {}
  const unassigned: typeof students = []

  students?.forEach((s) => {
    if (!s.classes) {
      unassigned.push(s)
    } else {
      const key = s.class_id!
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(s)
    }
  })

  // Build ordered class list (only classes that have students, unless filtered)
  const orderedClasses = classes?.filter((c) =>
    grouped[c.id] && grouped[c.id]!.length > 0
  ) ?? []

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Students</h1>
          <p className="text-slate-500 text-sm mt-1">{students?.length ?? 0} active students</p>
        </div>
        <Link href="/dashboard/students/new" className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={16} /> Add student
        </Link>
      </div>

      {/* Search + Class filter */}
      <div className="flex gap-3 mb-6">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <form>
            <input
              name="q" type="text" defaultValue={query}
              placeholder="Search by name..."
              className="input pl-9"
            />
            {classFilter && <input type="hidden" name="class" value={classFilter} />}
          </form>
        </div>

        {/* Class filter pills */}
        <div className="flex gap-2 flex-wrap items-center">
          <Link
            href="/dashboard/students"
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              !classFilter ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            All
          </Link>
          {classes?.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/students?class=${c.id}${query ? `&q=${query}` : ''}`}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                classFilter === c.id ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {c.name}{c.section ? ` - ${c.section}` : ''}
            </Link>
          ))}
        </div>
      </div>

      {/* Students grouped by class */}
      {students && students.length > 0 ? (
        <div className="flex flex-col gap-6">

          {/* Classes with students */}
          {orderedClasses.map((cls) => {
            const classStudents = grouped[cls.id] ?? []
            return (
              <div key={cls.id}>
                {/* Class header */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-1 h-5 bg-brand-600 rounded-full" />
                    <h2 className="font-semibold text-slate-800 text-sm">
                      {cls.name}{cls.section ? ` — ${cls.section}` : ''}
                    </h2>
                  </div>
                  <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                    {classStudents.length} student{classStudents.length !== 1 ? 's' : ''}
                  </span>
                </div>

                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Student ID</th>
                        <th>Father</th>
                        <th>Phone</th>
                        <th>Admitted</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {classStudents.map((student) => (
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
                            {student.student_uid
                              ? <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-700">{student.student_uid}</span>
                              : <span className="text-slate-400">—</span>}
                          </td>
                          <td>{(student as any).father_name ?? <span className="text-slate-400">—</span>}</td>
                          <td>{student.parent_phone ?? <span className="text-slate-400">—</span>}</td>
                          <td>
                            {student.admission_date
                              ? new Date(student.admission_date).toLocaleDateString('en-IN')
                              : <span className="text-slate-400">—</span>}
                          </td>
                          <td>
                            <Link href={`/dashboard/students/${student.id}`}
                              className="text-brand-600 text-sm font-medium hover:underline">
                              View
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}

          {/* Unassigned students */}
          {!classFilter && unassigned.length > 0 && (
            <div>
              <div className="flex items-center gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-5 bg-slate-300 rounded-full" />
                  <h2 className="font-semibold text-slate-500 text-sm">No class assigned</h2>
                </div>
                <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                  {unassigned.length}
                </span>
              </div>
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr><th>Name</th><th>Student ID</th><th>Father</th><th>Phone</th><th>Admitted</th><th></th></tr>
                  </thead>
                  <tbody>
                    {unassigned.map((student) => (
                      <tr key={student.id}>
                        <td>
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center shrink-0">
                              <span className="text-slate-500 font-medium text-xs">{student.full_name.charAt(0).toUpperCase()}</span>
                            </div>
                            <span className="font-medium text-slate-900">{student.full_name}</span>
                          </div>
                        </td>
                        <td>
                          {student.student_uid
                            ? <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-700">{student.student_uid}</span>
                            : <span className="text-slate-400">—</span>}
                        </td>
                        <td>{(student as any).father_name ?? <span className="text-slate-400">—</span>}</td>
                        <td>{student.parent_phone ?? <span className="text-slate-400">—</span>}</td>
                        <td>{student.admission_date ? new Date(student.admission_date).toLocaleDateString('en-IN') : '—'}</td>
                        <td>
                          <Link href={`/dashboard/students/${student.id}`} className="text-brand-600 text-sm font-medium hover:underline">View</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <Users size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">
            {query || classFilter ? 'No students found' : 'No students yet'}
          </h3>
          <p className="text-sm text-slate-500 mb-4">
            {query ? `No results for "${query}"` : classFilter ? 'No students in this class' : 'Add your first student to get started'}
          </p>
          {!query && !classFilter && (
            <Link href="/dashboard/students/new" className="btn-primary text-sm">+ Add student</Link>
          )}
        </div>
      )}
    </div>
  )
}
