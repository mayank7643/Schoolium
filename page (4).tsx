'use client'

// FILE: app/(dashboard)/dashboard/staff/page.tsx
//
// Staff directory (chat17). Visible content is enforced by RLS:
// school_admin/principal see all staff of their school; anyone else
// only their own row, so the page gates itself to admin/principal
// and shows a friendly card otherwise.

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import { Briefcase, Plus, Search } from 'lucide-react'
import type { EmploymentStatus } from '@/types'

interface StaffItem {
  id: string
  employee_id: string
  full_name: string
  mobile: string
  designation: string
  department: string
  is_teaching: boolean
  employment_status: EmploymentStatus
  joining_date: string
}

const STATUS_BADGE: Record<EmploymentStatus, { label: string; cls: string }> = {
  active:     { label: 'Active',     cls: 'badge-green'  },
  probation:  { label: 'Probation',  cls: 'badge-blue'   },
  on_leave:   { label: 'On leave',   cls: 'badge-yellow' },
  resigned:   { label: 'Resigned',   cls: 'badge-red'    },
  terminated: { label: 'Terminated', cls: 'badge-red'    },
  retired:    { label: 'Retired',    cls: 'badge-red'    },
}

function StatusBadge({ status }: { status: EmploymentStatus }) {
  const b = STATUS_BADGE[status] ?? STATUS_BADGE.active
  return <span className={b.cls}>{b.label}</span>
}

// -- Mobile card ---------------------------------------------------------------
function StaffCard({ member }: { member: StaffItem }) {
  return (
    <Link
      href={`/dashboard/staff/${member.id}`}
      className="flex items-center gap-3 px-4 py-3 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors active:bg-slate-100"
    >
      <div className="w-9 h-9 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
        <span className="text-brand-700 font-semibold text-sm">
          {member.full_name.charAt(0).toUpperCase()}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-slate-900 text-sm truncate">{member.full_name}</span>
          <span className="font-mono text-[10px] bg-brand-50 text-brand-700 border border-brand-200 px-1.5 py-0.5 rounded shrink-0">
            {member.employee_id}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400 flex-wrap">
          <span>{member.designation}</span>
          <span>·</span>
          <StatusBadge status={member.employment_status} />
        </div>
      </div>
      <span className="text-brand-600 text-xs font-medium shrink-0">View →</span>
    </Link>
  )
}

// -- Desktop row ----------------------------------------------------------------
function StaffRow({ member }: { member: StaffItem }) {
  return (
    <tr>
      <td>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
            <span className="text-brand-700 font-medium text-xs">
              {member.full_name.charAt(0).toUpperCase()}
            </span>
          </div>
          <span className="font-medium text-slate-900 truncate">{member.full_name}</span>
        </div>
      </td>
      <td>
        <span className="font-mono text-xs bg-brand-50 text-brand-700 border border-brand-200 px-2 py-0.5 rounded whitespace-nowrap">
          {member.employee_id}
        </span>
      </td>
      <td className="text-slate-600">{member.designation}</td>
      <td className="text-slate-600 font-mono text-xs">{member.mobile}</td>
      <td><StatusBadge status={member.employment_status} /></td>
      <td className="text-slate-500 text-xs">
        {new Date(member.joining_date).toLocaleDateString('en-IN')}
      </td>
      <td>
        <Link href={`/dashboard/staff/${member.id}`} className="text-brand-600 text-sm font-medium hover:underline">
          View
        </Link>
      </td>
    </tr>
  )
}

function GroupSeparatorRow({ label, count }: { label: string; count: number }) {
  return (
    <tr>
      <td colSpan={7} className="px-4 pt-5 pb-2 bg-transparent" style={{ borderTop: 'none' }}>
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-brand-600 rounded-full" />
          <span className="font-semibold text-slate-800 text-sm">{label}</span>
          <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
            {count} member{count !== 1 ? 's' : ''}
          </span>
        </div>
      </td>
    </tr>
  )
}

// -- Skeleton ---------------------------------------------------------------------
function ListSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-slate-50 last:border-0">
          <div className="w-9 h-9 bg-slate-100 rounded-full animate-pulse shrink-0" />
          <div className="flex-1">
            <div className="h-3.5 w-32 bg-slate-100 rounded animate-pulse mb-1.5" />
            <div className="h-3 w-24 bg-slate-100 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------
export default function StaffPage() {
  const [allowed, setAllowed]       = useState<boolean | null>(null)
  const [staff, setStaff]           = useState<StaffItem[]>([])
  const [loading, setLoading]       = useState(true)
  const [query, setQuery]           = useState('')
  const [deptFilter, setDeptFilter] = useState('')
  const [showFormer, setShowFormer] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchStaff = useCallback(async (q: string) => {
    const supabase = createClient()
    let sq = supabase
      .from('staff')
      .select('id, employee_id, full_name, mobile, designation, department, is_teaching, employment_status, joining_date')
      .order('full_name')

    if (q) sq = sq.ilike('full_name', `%${q}%`)

    const { data } = await sq
    setStaff((data ?? []) as any as StaffItem[])
  }, [])

  useEffect(() => {
    async function init() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setAllowed(false); setLoading(false); return }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      const ok = profile?.role === 'school_admin' || profile?.role === 'principal'
      setAllowed(ok)
      if (ok) await fetchStaff('')
      setLoading(false)
    }
    init()
  }, [fetchStaff])

  function handleSearch(q: string) {
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { fetchStaff(q) }, 350)
  }

  // -- Derived: departments + visibility filter ------------------------------
  const visible = staff.filter(m => {
    const former = ['resigned', 'terminated', 'retired'].includes(m.employment_status)
    if (former && !showFormer) return false
    if (deptFilter && m.department !== deptFilter) return false
    return true
  })

  const departments = Array.from(new Set(staff.map(m => m.department))).sort()

  const grouped: Record<string, StaffItem[]> = {}
  visible.forEach(m => {
    if (!grouped[m.department]) grouped[m.department] = []
    grouped[m.department].push(m)
  })
  const orderedDepts = Object.keys(grouped).sort()

  // -- Access card for non-admin roles ---------------------------------------
  if (!loading && allowed === false) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">Staff</h1>
          <p className="text-sm text-slate-500">
            Only a school admin or principal can view the staff directory.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold text-slate-900">Staff</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {loading
              ? <span className="inline-block h-3 w-24 bg-slate-200 rounded animate-pulse" />
              : `${visible.length} member${visible.length !== 1 ? 's' : ''}${showFormer ? ' (incl. former)' : ''}`}
          </p>
        </div>
        <Link href="/dashboard/staff/new" className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={16} /> Add staff
        </Link>
      </div>

      {/* Search + filters */}
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
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <button
            onClick={() => setDeptFilter('')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              !deptFilter ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >All</button>
          {departments.map(d => (
            <button key={d} onClick={() => setDeptFilter(d)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                deptFilter === d ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >{d}</button>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-slate-500 ml-auto cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showFormer}
              onChange={e => setShowFormer(e.target.checked)}
              className="rounded border-slate-300"
            />
            Show former staff
          </label>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <ListSkeleton />
      ) : visible.length > 0 ? (
        <>
          {/* Mobile - card groups per department */}
          <div className="lg:hidden flex flex-col gap-6">
            {orderedDepts.map(dept => (
              <div key={dept}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-1 h-5 bg-brand-600 rounded-full" />
                  <h2 className="font-semibold text-slate-800 text-sm">{dept}</h2>
                  <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                    {grouped[dept].length}
                  </span>
                </div>
                <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
                  {grouped[dept].map(m => <StaffCard key={m.id} member={m} />)}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop - single table, department separator rows */}
          <div className="hidden lg:block table-wrapper">
            <table className="table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: '24%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '8%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Employee ID</th>
                  <th>Designation</th>
                  <th>Mobile</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {orderedDepts.map(dept => (
                  <React.Fragment key={dept}>
                    <GroupSeparatorRow label={dept} count={grouped[dept].length} />
                    {grouped[dept].map(m => <StaffRow key={m.id} member={m} />)}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <Briefcase size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">
            {query || deptFilter ? 'No staff found' : 'No staff yet'}
          </h3>
          <p className="text-sm text-slate-500 mb-4">
            {query
              ? `No results for "${query}"`
              : deptFilter
              ? 'No staff in this department'
              : 'Add your first staff member to get started'}
          </p>
          {!query && !deptFilter && (
            <Link href="/dashboard/staff/new" className="btn-primary text-sm">+ Add staff</Link>
          )}
        </div>
      )}
    </div>
  )
}
