'use client'

// FILE: app/(dashboard)/dashboard/my-classes/page.tsx
//
// My Classes (chat18 Teacher Workspace). Shows ONLY the classes this
// teacher is connected to - class teacher of, or teaches a subject in.
// No class CRUD here (that stays with admin/principal). Each class
// opens the class workspace: roster, roll-call attendance (class
// teachers only) and the read-only fee summary (class teachers only).

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { BookOpen, GraduationCap } from 'lucide-react'
import type { TeacherAssignments } from '@/types'

interface MyClass {
  class_id: string
  name: string
  section: string | null
  isClassTeacher: boolean
  subjects: string[]
}

export default function MyClassesPage() {
  const [classes, setClasses] = useState<MyClass[]>([])
  const [loading, setLoading] = useState(true)
  const [noStaff, setNoStaff] = useState(false)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data, error } = await supabase.rpc('get_teacher_assignments')

      if (error || !data) {
        setNoStaff(true)
        setLoading(false)
        return
      }

      const a = data as TeacherAssignments
      const map = new Map<string, MyClass>()

      a.class_teacher_of.forEach(c => {
        map.set(c.class_id, {
          class_id: c.class_id, name: c.name, section: c.section,
          isClassTeacher: true, subjects: [],
        })
      })
      a.subjects.forEach(s => {
        const existing = map.get(s.class_id)
        if (existing) {
          existing.subjects.push(s.subject)
        } else {
          map.set(s.class_id, {
            class_id: s.class_id, name: s.class_name, section: s.section,
            isClassTeacher: false, subjects: [s.subject],
          })
        }
      })

      const list = Array.from(map.values()).sort((x, y) => {
        const xn = parseInt(x.name), yn = parseInt(y.name)
        if (!isNaN(xn) && !isNaN(yn) && xn !== yn) return xn - yn
        const n = x.name.localeCompare(y.name)
        return n !== 0 ? n : (x.section ?? '').localeCompare(y.section ?? '')
      })

      setClasses(list)
      setLoading(false)
    })()
  }, [])

  if (!loading && noStaff) {
    return (
      <div className="max-w-2xl">
        <div className="card">
          <h1 className="text-lg font-semibold text-slate-900 mb-1">My classes</h1>
          <p className="text-sm text-slate-500">No staff record is linked to this account.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">My classes</h1>
        <p className="text-slate-500 text-sm">
          Classes you are class teacher of, or teach a subject in
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card h-32 animate-pulse bg-slate-50" />
          ))}
        </div>
      ) : classes.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mb-4">
            <GraduationCap size={24} className="text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 mb-1">No classes assigned yet</h3>
          <p className="text-sm text-slate-500">
            Your admin will assign you classes and subjects.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {classes.map(c => (
            <Link key={c.class_id} href={`/dashboard/my-classes/${c.class_id}`}
              className="card hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between gap-2">
                <div className="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center shrink-0">
                  <BookOpen size={18} className="text-brand-600" />
                </div>
                {c.isClassTeacher && <span className="badge-blue">Class teacher</span>}
              </div>
              <p className="font-semibold text-slate-900 mt-3">
                Class {c.name}{c.section ? ` - ${c.section}` : ''}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                {c.subjects.length > 0 ? c.subjects.join(', ') : 'Class teacher'}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
