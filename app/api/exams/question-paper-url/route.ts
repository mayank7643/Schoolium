// FILE: app/api/exams/question-paper-url/route.ts
// Exchange an authorized question-paper access for a 60-second signed
// URL. The DB RPC (caller's own session) validates assignment/role and
// INSERTS the access-log row BEFORE returning the storage path; only
// then does this route sign the URL with the service key. Teachers
// have no direct storage read - this is the only download path.

import { NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/utils/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export async function POST(req: Request) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('Not authenticated', 401)

  let body: { question_paper_id?: string; version_id?: string | null }
  try { body = await req.json() } catch { return bad('Invalid request body') }
  if (!body.question_paper_id) return bad('question_paper_id is required')

  // caller-session RPC: validates + logs + returns the path
  const { data: path, error } = await supabase.rpc('authorize_question_paper_access', {
    p_question_paper_id: body.question_paper_id,
    p_version_id: body.version_id ?? null,
  })
  if (error) {
    const status = error.message.includes('Access denied') ? 403
      : error.message.includes('not found') ? 404 : 400
    return bad(error.message, status)
  }

  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  const { data: signed, error: signErr } = await service.storage
    .from('question-papers')
    .createSignedUrl(path as string, 60)
  if (signErr || !signed?.signedUrl) {
    return bad('File not found in storage - the upload may not have completed. Re-upload the paper.', 404)
  }

  return NextResponse.json({ url: signed.signedUrl })
}
