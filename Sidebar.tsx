'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import {
  LayoutDashboard,
  Users,
  IndianRupee,
  BookOpen,
  LogOut,
  School,
} from 'lucide-react'

const navItems = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Students', href: '/dashboard/students', icon: Users },
  { label: 'Fees', href: '/dashboard/fees', icon: IndianRupee },
  { label: 'Classes', href: '/dashboard/classes', icon: BookOpen },
]

interface SidebarProps {
  profile: {
    full_name: string
    role: string
    schools: {
      name: string
    } | null
  } | null
}

export default function Sidebar({ profile }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="w-60 min-h-screen bg-white border-r border-slate-100 flex flex-col shrink-0">
      {/* Logo + School name */}
      <div className="px-5 py-5 border-b border-slate-100">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 bg-brand-600 rounded-md flex items-center justify-center">
            <span className="text-white font-bold text-xs">S</span>
          </div>
          <span className="font-semibold text-slate-900">Schoolium</span>
        </div>
        <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
          <School size={14} className="text-slate-400 shrink-0" />
          <span className="text-xs text-slate-600 font-medium truncate">
            {profile?.schools?.name ?? 'Your School'}
          </span>
        </div>
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-3 py-4 flex flex-col gap-1">
        {navItems.map(({ label, href, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link
              key={href}
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
        })}
      </nav>

      {/* User info + logout */}
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
    </aside>
  )
}
