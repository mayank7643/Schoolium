// ============================================
// SCHOOLIUM — DATABASE TYPES
// Matches the Supabase schema exactly
// ============================================

export type Plan = 'basic' | 'pro' | 'enterprise'
export type Role = 'super_admin' | 'school_admin' | 'teacher' | 'parent'
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
  plan: Plan
  is_active: boolean
  created_at: string
}

export interface Profile {
  id: string
  school_id: string | null
  full_name: string
  role: Role
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
