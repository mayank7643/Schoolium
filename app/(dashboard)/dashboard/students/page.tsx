'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import { Users, Plus, Search, ChevronDown } from 'lucide-react'

const PAGE_SIZE = 50

interface ClassItem {
  id: string
  name: string
  section: string | null
}

interface StudentItem {
  id: string
  full_name: string
  student_uid: string | null
  father_name: string | null
  parent_phone: string | null
  admission_date: string
  class_id: string | null
  classes?: { id: string; name: string; section: string | null } | null
}

function sortClasses(classes: ClassItem[]): ClassItem[] {
  return [...classes].sort((a, b) => {
    const aNum = parseInt(a.name), bNum = parseInt(b.name)
    const aIsNum = !isNaN(aNum), bIsNum = !isNaN(bNum)
    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum - bNum
      return (a.section ?? '').localeCompare(b.section ?? '')
    }
    if (aIsNum) return -1
    if (bIsNum) return 1
    const n = a.name.localeCompare(b.name)
    return n !== 0 ? n : (a.section ?? '').localeCompare(b.section ?? '')
  })
}

// ── Avatar colour helper ───────────────────────────────────────────────────────
function avatarBgForClass(classId: string | null): string {
  return classId ? 'bg-brand-100' : 'bg-slate-100'
}

// ── Mobile card ───────────────────────────────────────────────────────────────
function StudentCard({ student }: { student: StudentItem }) {
  const avatarBg = avatarBgForClass(student.class_id)
  return (
    <Link
      href={`/dashboard/students/${student.id}`}
      className="flex items-center gap-3 px-4 py-3 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors active:bg-slate-100"
    >
      <div className={`w-9 h-9 ${avatarBg} rounded-full flex items-center justify-center shrink-0`}>
        <span className="text-brand-700 font-semibold text-sm">
          {student.full_name.charAt(0).toUpperCase()}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-slate-900 text-sm truncate">{student.full_name}</span>
          {student.student_uid && (
            <span className="font-mono text-[10px] bg-brand-50 text-brand-700 border border-brand-200 px-1.5 py-0.5 rounded shrink-0">
              {student.student_uid}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400 flex-wrap">
          {student.father_name && <span>{student.father_name}</span>}
          {student.father_name && student.parent_phone && <span>·</span>}
          {student.parent_phone && <span className="font-mono">{student.parent_phone}</span>}
        </div>
      </div>
      <span className="text-brand-600 text-xs font-medium shrink-0">View →</span>
    </Link>
  )
}

// ── Desktop table row ─────────────────────────────────────────────────────────
// No avatarBg prop needed — derived from class_id directly
function StudentRow({ student }: { student: StudentItem }) {
  const avatarBg = avatarBgForClass(student.class_id)
  return (
    <tr>
      <td>
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 ${avatarBg} rounded-full flex items-center justify-center shrink-0`}>
            <span className="text-brand-700 font-medium text-xs">
              {student.full_name.charAt(0).toUpperCase()}
            </span>
          </div>
          <span className="font-medium text-slate-900 truncate">{student.full_name}</span>
        </div>
      </td>
      <td>
        {student.student_uid
          ? <span className="font-mono text-xs bg-brand-50 text-brand-700 border border-brand-200 px-2 py-0.5 rounded whitespace-nowrap">{student.student_uid}</span>
          : <span className="text-slate-300">—</span>}
      </td>
      <td className="text-slate-600">{student.father_name ?? <span className="text-slate-300">—</span>}</td>
      <td className="text-slate-600 font-mono text-xs">{student.parent_phone ?? <span className="text-slate-300">—</span>}</td>
      <td className="text-slate-500 text-xs">
        {student.admission_date
          ? new Date(student.admission_date).toLocaleDateString('en-IN')
          : <span className="text-slate-300">—</span>}
      </td>
      <td>
        <Link href={`/dashboard/students/${student.id}`} className="text-brand-600 text-sm font-medium hover:underline">
          View
        </Link>
      </td>
    </tr>
  )
}

// ── Group separator row — sits inside the shared <tbody> ──────────────────────
function GroupSeparatorRow({ label, count, accent }: { label: string; count: number; accent: string }) {
  return (
    <tr>
      <td
        colSpan={6}
        className="px-4 pt-5 pb-2 bg-transparent"
        style={{ borderTop: 'none' }}
      >
        <div className="flex items-center gap-3">
          <div className={`w-1 h-5 ${accent} rounded-full`} />
          <span className="font-semibold text-slate-800 text-sm">{label}</span>
          <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
            {count} student{count !== 1 ? 's' : ''}
          </span>
        </div>
      </td>
    </tr>
  )
}

// ── Skeletons ─────────────────────────────────────────────────────────────────
function CardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-slate-50 last:border-0">
          <div className="w-9 h-9 bg-slate-100 rounded-full animate-pulse shrink-0" />
          <div className="flex-1">
            <div className="h-3.5 w-28 bg-slate-100 rounded animate-pulse mb-1.5" />
            <div className="h-3 w-20 bg-slate-100 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="table-wrapper">
      <table className="table" style={{ tableLayout: 'fixed', width: '100%' }}>
        <colgroup>
          <col style={{ width: '28%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '16%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '8%' }} />
        </colgroup>
        <thead>
          <tr><th>Name</th><th>Student ID</th><th>Father</th><th>Phone</th><th>Admitted</th><th></th></tr>
        </thead>
        <tbody>
          {[...Array(4)].map((_, i) => (
            <tr key={i}>
              <td><div className="flex items-center gap-3"><div className="w-8 h-8 bg-slate-100 rounded-full animate-pulse shrink-0" /><div className="h-3.5 w-28 bg-slate-100 rounded animate-pulse" /></div></td>
              <td><div className="h-3.5 w-20 bg-slate-100 rounded animate-pulse" /></td>
              <td><div className="h-3.5 w-24 bg-slate-100 rounded animate-pulse" /></td>
              <td><div className="h-3.5 w-20 bg-slate-100 rounded animate-pulse" /></td>
              <td><div className="h-3.5 w-16 bg-slate-100 rounded animate-pulse" /></td>
              <td><div className="h-3.5 w-8 bg-slate-100 rounded animate-pulse" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
export default function StudentsPage() {
  const [classes, setClasses]             = useState<ClassItem[]>([])
  const [students, setStudents]           = useState<StudentItem[]>([])
  const [totalCount, setTotalCount]       = useState(0)
  const [page, setPage]                   = useState(0)
  const [hasMore, setHasMore]             = useState(false)
  const [loadingMore, setLoadingMore]     = useState(false)
  const [loading, setLoading]             = useState(true)
  const [filterLoading, setFilterLoading] = useState(false)
  const [query, setQuery]                 = useState('')
  const [classFilter, setClassFilter]     = useState('')

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Core fetch ────────────────────────────────────────────────────────────
  const fetchStudents = useCallback(async (
    cls: string,
    q: string,
    pageNum: number,
    append: boolean
  ) => {
    const supabase = createClient()
    const from = pageNum * PAGE_SIZE
    const to   = from + PAGE_SIZE - 1

    let sq = supabase
      .from('students')
      .select('id, full_name, student_uid, father_name, parent_phone, admission_date, class_id, classes(id, name, section)', { count: 'exact' })
      .eq('is_active', true)
      .order('full_name')
      .range(from, to)

    if (q)   sq = sq.ilike('full_name', `%${q}%`)
    if (cls) sq = sq.eq('class_id', cls)

    const { data, count } = await sq

    const rows = (data ?? []) as any as StudentItem[]
    const total = count ?? 0

    if (append) {
      setStudents(prev => [...prev, ...rows])
    } else {
      setStudents(rows)
    }

    setTotalCount(total)
    setHasMore(from + rows.length < total)
    setPage(pageNum)
  }, [])

  // ── Initial load ──────────────────────────────────────────────────────────
  const initialLoad = useCallback(async () => {
    const supabase = createClient()
    const [classesRes] = await Promise.all([
      supabase.from('classes').select('id, name, section').order('name'),
      fetchStudents('', '', 0, false),
    ])
    setClasses(sortClasses(classesRes.data ?? []))
    setLoading(false)
  }, [fetchStudents])

  useEffect(() => { initialLoad() }, [initialLoad])

  // ── Class filter ──────────────────────────────────────────────────────────
  async function handleClassFilter(cls: string) {
    setClassFilter(cls)
    setFilterLoading(true)
    await fetchStudents(cls, query, 0, false)
    setFilterLoading(false)
  }

  // ── Search — debounced 350ms ──────────────────────────────────────────────
  function handleSearch(q: string) {
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setFilterLoading(true)
      await fetchStudents(classFilter, q, 0, false)
      setFilterLoading(false)
    }, 350)
  }

  // ── Load more ─────────────────────────────────────────────────────────────
  async function handleLoadMore() {
    setLoadingMore(true)
    await fetchStudents(classFilter, query, page + 1, true)
    setLoadingMore(false)
  }

  // ── Group by class ────────────────────────────────────────────────────────
  const grouped: Record<string, StudentItem[]> = {}
  const unassigned: StudentItem[] = []
  students.forEach(s => {
    if (!s.classes) { unassigned.push(s); return }
    const key = s.class_id!
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(s)
  })
  const orderedClasses = classes.filter(c => grouped[c.id]?.length > 0)

  // ── Shared desktop table — ONE table, all groups ──────────────────────────
  // Class groups become separator rows inside a single <tbody>.
  // The shared <colgroup> locks every column to the same width across all groups.
  // Mobile card layout is completely separate and unaffected.
  function DesktopTable() {
    return (
      <div className="hidden lg:block table-wrapper">
        <table className="table" style={{ tableLayout: 'fixed', width: '100%' }}>
          <colgroup>
            <col style={{ width: '28%' }} /> {/* Name */}
            <col style={{ width: '14%' }} /> {/* Student ID */}
            <col style={{ width: '20%' }} /> {/* Father */}
            <col style={{ width: '16%' }} /> {/* Phone */}
            <col style={{ width: '14%' }} /> {/* Admitted */}
            <col style={{ width: '8%' }} />  {/* View */}
          </colgroup>
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
            {/* Named class groups */}
            {orderedClasses.map(cls => (
              <>
                <GroupSeparatorRow
                  key={`sep-${cls.id}`}
                  label={`${cls.name}${cls.section ? ` — ${cls.section}` : ''}`}
                  count={(grouped[cls.id] ?? []).length}
                  accent="bg-brand-600"
                />
                {(grouped[cls.id] ?? []).map(s => (
                  <StudentRow key={s.id} student={s} />
                ))}
              </>
            ))}

            {/* Unassigned group */}
            {!classFilter && unassigned.length > 0 && (
              <>
                <GroupSeparatorRow
                  key="sep-unassigned"
                  label="No class assigned"
                  count={unassigned.length}
                  accent="bg-slate-300"
                />
                {unassigned.map(s => (
                  <StudentRow key={s.id} student={s} />
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    )
  }

  // ── Mobile card groups ────────────────────────────────────────────────────
  function MobileGroups() {
    return (
      <div className="lg:hidden flex flex-col gap-6">
        {orderedClasses.map(cls => (
          <div key={cls.id}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-1 h-5 bg-brand-600 rounded-full" />
              <h2 className="font-semibold text-slate-800 text-sm">
                {cls.name}{cls.section ? ` — ${cls.section}` : ''}
              </h2>
              <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                {(grouped[cls.id] ?? []).length} student{(grouped[cls.id] ?? []).length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
              {(grouped[cls.id] ?? []).map(s => <StudentCard key={s.id} student={s} />)}
            </div>
          </div>
        ))}

        {!classFilter && unassigned.length > 0 && (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-1 h-5 bg-slate-300 rounded-full" />
              <h2 className="font-semibold text-slate-500 text-sm">No class assigned</h2>
              <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{unassigned.length}</span>
            </div>
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
              {unassigned.map(s => <StudentCard key={s.id} student={s} />)}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold text-slate-900">Students</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {loading
              ? <span className="inline-block h-3 w-24 bg-slate-200 rounded animate-pulse" />
              : totalCount > students.length
              ? `Showing ${students.length} of ${totalCount} students`
              : `${totalCount} active student${totalCount !== 1 ? 's' : ''}`}
          </p>
        </div>
        <Link href="/dashboard/students/new" className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={16} /> Add student
        </Link>
      </div>

      {/* Search + filter */}
      <div className="flex flex-col gap-3 mb-5">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search by name..."
            className="input pl-9"
          />
          {query && filterLoading && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <span className="w-3.5 h-3.5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin block" />
            </div>
          )}
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          {loading ? (
            [...Array(5)].map((_, i) => (
              <div key={i} className="h-7 w-12 bg-slate-100 rounded-lg animate-pulse" />
            ))
          ) : (
            <>
              <button
                onClick={() => handleClassFilter('')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  !classFilter ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >All</button>
              {classes.map(c => (
                <button key={c.id} onClick={() => handleClassFilter(c.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    classFilter === c.id ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {c.name}{c.section ? ` - ${c.section}` : ''}
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex flex-col gap-6">
          {[...Array(2)].map((_, i) => (
            <div key={i}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-1 h-5 bg-slate-200 rounded-full" />
                <div className="h-3.5 w-24 bg-slate-200 rounded animate-pulse" />
                <div className="h-5 w-14 bg-slate-100 rounded-full animate-pulse" />
              </div>
              <div className="lg:hidden"><CardSkeleton /></div>
              <div className="hidden lg:block"><TableSkeleton /></div>
            </div>
          ))}
        </div>
      ) : filterLoading && students.length === 0 ? (
        <div>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-1 h-5 bg-brand-200 rounded-full" />
            <div className="h-3.5 w-32 bg-slate-200 rounded animate-pulse" />
          </div>
          <div className="lg:hidden"><CardSkeleton /></div>
          <div className="hidden lg:block"><TableSkeleton /></div>
        </div>
      ) : students.length > 0 ? (
        <>
          {/* Mobile — separate card groups per class */}
          <MobileGroups />

          {/* Desktop — one single table, all groups, locked column widths */}
          <DesktopTable />

          {/* Load more */}
          {hasMore && (
            <div className="mt-6 flex flex-col items-center gap-2">
              <p className="text-xs text-slate-400">
                Showing {students.length} of {totalCount} students
              </p>
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="btn-secondary flex items-center gap-2 text-sm px-6"
              >
                {loadingMore
                  ? <><span className="w-3.5 h-3.5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />Loading...</>
                  : <><ChevronDown size={15} />Load more students</>}
              </button>
            </div>
          )}
        </>
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
