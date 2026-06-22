// ============================================
// SCHOOLIUM — DATABASE TYPES
// Matches the Supabase schema exactly
// ============================================

export type Plan = 'basic' | 'standard' | 'premium'
export type Role = 'super_admin' | 'school_admin' | 'teacher' | 'guard' | 'parent'  // added: guard
export type Gender = 'male' | 'female' | 'other'
export type FeeType = 'tuition' | 'exam' | 'transport' | 'other'
export type FeeStatus = 'pending' | 'paid' | 'overdue'
export type PaymentMethod = 'cash' | 'upi' | 'bank_transfer' | 'online'

export interface School {
  id: string
  name: string
  address: string | null
  phone: string | null
  email: string | null
  logo_url: string | null
  plan: Plan | null
  is_active: boolean
  created_at: string
  // WhatsApp feature gate
  wa_alerts_enabled: boolean
  wa_monthly_quota: number
  wa_messages_sent_month: number
  wa_quota_reset_date: string | null
}

export interface Profile {
  id: string
  school_id: string | null
  full_name: string
  role: Role
  gate: string | null   // added: guard gate assignment (e.g. 'Main Gate')
  phone: string | null
  is_active: boolean
  created_at: string
}

export interface Class {
  id: string
  school_id: string
  name: string
  section: string | null
  created_at: string
}

export interface Student {
  id: string
  school_id: string
  class_id: string | null
  full_name: string
  student_uid: string | null       // e.g. GN-26-0001
  father_name: string | null
  mother_name: string | null
  date_of_birth: string | null
  gender: Gender | null
  aadhaar_number: string | null
  address: string | null
  parent_name: string | null       // kept for backward compat
  parent_phone: string | null
  parent_email: string | null
  photo_url: string | null
  is_active: boolean
  admission_date: string
  created_at: string
  parent_phone_opted_out: boolean  // WA opt-out — set when parent replies STOP
  // joined
  classes?: Class
}

export interface Fee {
  id: string
  school_id: string
  student_id: string
  amount: number
  fee_type: FeeType
  due_date: string | null
  paid_date: string | null
  status: FeeStatus
  payment_method: PaymentMethod | null
  receipt_number: string | null
  notes: string | null
  period_months: string[] | null   // e.g. ['2026-05','2026-06']
  created_at: string
  // joined
  student?: Student
}

export interface Attendance {
  id: string
  school_id: string
  student_id: string
  scan_date: string                  // DATE — 'YYYY-MM-DD'
  scan_time: string                  // TIMESTAMPTZ — full ISO string
  entry_type: 'entry' | 'exit'      // added: matches attendance_unique_per_day_and_type index
  gate: string                       // e.g. 'Main Gate', 'Side Gate'
  guard_id: string | null            // guard user id or name, nullable
  exam_id: string | null             // nullable FK — for future exam-day attendance
  created_at: string
  // joined
  student?: Student
}

// ============================================
// DASHBOARD SUMMARY TYPES
// ============================================

export interface DashboardStats {
  totalStudents: number
  totalFeesCollected: number
  totalFeesPending: number
  totalClasses: number
}

// ============================================
// ATTENDANCE SUMMARY TYPES
// ============================================

export interface AttendanceSummary {
  date: string
  total_present: number
  total_students: number
  attendance_rate: number   // computed: total_present / total_students * 100
}
