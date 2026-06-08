import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*, schools(*)')
    .eq('id', user.id)
    .single()

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar profile={profile} />

      {/*
        Desktop: no top/bottom offset — sidebar is fixed to left
        Mobile:
          pt-14  → clears the fixed top bar (h-14)
          pb-20  → clears the fixed bottom nav (h-16) + safe area
      */}
      <main className="flex-1 min-w-0 p-4 lg:p-6 pt-[72px] pb-24 lg:pt-6 lg:pb-6">
        {children}
      </main>
    </div>
  )
}
