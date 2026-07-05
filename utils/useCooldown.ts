'use client'

// FILE: utils/useCooldown.ts
// Small countdown used to throttle "send / resend code" buttons on the
// auth pages, so a user cannot hammer Supabase's OTP endpoints from the
// client. Server-side limits (Supabase Auth rate limits + the
// email_exists limiter) are the real backstop - this is just UX.

import { useCallback, useEffect, useState } from 'react'

export function useCooldown(seconds = 45) {
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (remaining <= 0) return
    const t = setTimeout(() => setRemaining(r => r - 1), 1000)
    return () => clearTimeout(t)
  }, [remaining])

  const start = useCallback(() => setRemaining(seconds), [seconds])

  return { remaining, active: remaining > 0, start }
}
