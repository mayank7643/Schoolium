'use client'

// FILE: components/layout/Sidebar.tsx
// Updated: added Attendance nav item

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import {
  LayoutDashboard,
  Users,
  IndianRupee,
  BookOpen,
  CalendarCheck,
  LogOut,
  School,
  Settings,
  X,
  Menu,
} from 'lucide-react'
import { useState, useEffect } from 'react'

const navItems = [
  { label: 'Dashboard',  href: '/dashboard',            icon: LayoutDashboard },
  { label: 'Students',   href: '/dashboard/students',   icon: Users           },
  { label: 'Fees',       href: '/dashboard/fees',       icon: IndianRupee     },
  { label: 'Classes',    href: '/dashboard/classes',    icon: BookOpen        },
  { label: 'Attendance', href: '/dashboard/attendance', icon: CalendarCheck   },
]

interface SidebarProps {
  profile: {
    full_name: string
    role: string
    schools: { name: string } | null
  } | null
}

export default function Sidebar({ profile }: SidebarProps) {
  const pathname = usePathname()
  const router   = useRouter()
  const [open, setOpen] = useState(false)

  useEffect(() => { setOpen(false) }, [pathname])

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === href
    return pathname.startsWith(href)
  }

  function NavLink({ href, icon: Icon, label }: { href: string; icon: React.ElementType; label: string }) {
    const active = isActive(href)
    return (
      <Link
        href={href}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-100 ${
          active
            ? 'bg-brand-50 text-brand-700'
            : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
        }`}
      >
        <Icon size={17} className={active ? 'text-brand-600' : 'text-slate-400'} />
        {label}
      </Link>
    )
  }

  function SidebarContent() {
    return (
      <div className="flex flex-col h-full">
        <div className="px-5 py-5 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 bg-brand-600 rounded-md flex items-center justify-center shrink-0">
                <span className="text-white font-bold text-xs">S</span>
              </div>
              <span className="font-semibold text-slate-900">Schoolium</span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="lg:hidden w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100"
            >
              <X size={18} className="text-slate-500" />
            </button>
          </div>
          <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
            <School size={14} className="text-slate-400 shrink-0" />
            <span className="text-xs text-slate-600 font-medium truncate">
              {profile?.schools?.name ?? 'Your School'}
            </span>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 flex flex-col gap-1">
          {navItems.map(item => <NavLink key={item.href} {...item} />)}
          {profile?.role === 'school_admin' && (
            <NavLink href="/dashboard/settings" icon={Settings} label="Settings" />
          )}
        </nav>

        <div className="px-3 py-4 border-t border-slate-100">
          <div className="px-3 py-2 mb-1">
            <p className="text-sm font-medium text-slate-800 truncate">{profile?.full_name}</p>
            <p className="text-xs text-slate-400 capitalize">{profile?.role?.replace('_', ' ')}</p>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-600 transition-colors duration-100"
          >
            <LogOut size={17} className="text-slate-400" />
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 min-h-screen bg-white border-r border-slate-100 flex-col shrink-0">
        <SidebarContent />
      </aside>

      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-slate-100 flex items-center justify-between px-4 h-14">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-brand-600 rounded-md flex items-center justify-center">
            <span className="text-white font-bold text-xs">S</span>
          </div>
          <span className="font-semibold text-slate-900 text-sm">
            {profile?.schools?.name ?? 'Schoolium'}
          </span>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-slate-100"
          aria-label="Open menu"
        >
          <Menu size={20} className="text-slate-600" />
        </button>
      </div>

      {/* Mobile drawer backdrop */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/40"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={`lg:hidden fixed top-0 left-0 bottom-0 z-50 w-72 bg-white shadow-2xl
          transform transition-transform duration-300 ease-in-out
          ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <SidebarContent />
      </aside>

      {/* Mobile bottom nav — 5 items, smaller label */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-slate-100 flex items-center justify-around px-1 h-16 safe-area-pb">
        {navItems.map(({ href, icon: Icon, label }) => {
          const active = isActive(href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl flex-1 transition-colors ${
                active ? 'text-brand-600' : 'text-slate-400'
              }`}
            >
              <Icon size={19} strokeWidth={active ? 2.5 : 1.8} />
              <span className={`text-[9px] font-medium ${active ? 'text-brand-600' : 'text-slate-400'}`}>
                {label}
              </span>
            </Link>
          )
        })}
      </nav>
    </>
  )
}
