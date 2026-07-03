// FILE: app/api/fee-summary-pdf/route.ts
// Builds the school fee-summary PDF for the given filter and returns it as a
// download. Auth is the caller's own session; the get_fee_summary RPC enforces
// admin/collector role + school scope.

import { createClient } from '@/utils/supabase/server'
import { renderFeeSummaryPdfBuffer, FeeSummaryRow } from '@/app/lib/feeSummaryPdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  let body: { class_name?: string | null; section?: string | null } = {}
  try { body = await req.json() } catch { /* whole school */ }
  const className = body.class_name?.trim() || null
  const section   = body.section?.trim() || null

  const { data, error } = await supabase.rpc('get_fee_summary', {
    p_class_name: className,
    p_section:    section,
  })
  if (error) {
    const status = error.message.includes('Access denied') ? 403 : 400
    return new Response(JSON.stringify({ error: error.message }), { status })
  }

  const rows = (data as FeeSummaryRow[]) || []

  // School name for the heading.
  const { data: prof } = await supabase
    .from('profiles')
    .select('schools(name)')
    .eq('id', user.id)
    .single()
  const schoolName = ((prof as any)?.schools?.name as string) || 'School'

  const filterLabel =
    className && section ? `Class ${className}-${section}`
    : className          ? `Class ${className} (all sections)`
    :                      'Whole school'

  const withDues = rows.filter(r => r.due_count > 0).length
  const doc = {
    schoolName,
    filterLabel,
    generatedAt: new Date().toLocaleString('en-IN', {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }),
    rows,
    totals: {
      students: rows.length,
      withDues,
      cleared: rows.length - withDues,
      outstanding: rows.reduce((s, r) => s + Number(r.outstanding || 0), 0),
    },
  }

  const pdf = await renderFeeSummaryPdfBuffer(doc)
  const safe = filterLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase()

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="fee-summary-${safe}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}
