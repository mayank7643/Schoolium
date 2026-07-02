// ============================================
// SCHOOLIUM — DATABASE TYPES
// Matches the Supabase schema exactly
// ============================================

export type Plan           = 'basic' | 'standard' | 'premium'
export type Role           = 'super_admin' | 'school_admin' | 'teacher' | 'guard' | 'parent'
export type Gender         = 'male' | 'female' | 'other'
export type EntryType      = 'entry' | 'exit'

// ── Legacy fee types (existing 'fees' table — untouched) ──────────────────────
export type FeeType        = 'tuition' | 'exam' | 'transport' | 'other'
export type FeeStatus      = 'pending' | 'paid' | 'overdue'
export type PaymentMethod  = 'cash' | 'upi' | 'bank_transfer' | 'card' | 'cheque' | 'other'

// ── New fee module types ──────────────────────────────────────────────────────
export type FeeFrequency   = 'monthly' | 'one_time' | 'quarterly' | 'custom'
export type DueStatus      = 'unpaid' | 'partial' | 'paid' | 'waived'
export type DiscountType   = 'percentage' | 'fixed'
export type LateFeeType    = 'fixed' | 'percentage'
export type FeeModuleType  = 'tuition' | 'admission' | 'exam' | 'transport' | 'hostel' | 'custom'
export type ReminderType   = 'due' | 'overdue'


// ============================================
// CORE TABLES
// ============================================

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
  // WhatsApp — controls ALL WA features including fee reminders
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
  gate: string | null
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
  student_uid: string | null
  father_name: string | null
  mother_name: string | null
  date_of_birth: string | null
  gender: Gender | null
  aadhaar_number: string | null
  address: string | null
  parent_name: string | null
  parent_phone: string | null
  parent_email: string | null
  photo_url: string | null
  is_active: boolean
  admission_date: string
  created_at: string
  parent_phone_opted_out: boolean
  fee_structure_id: string | null    // assigned default fee structure
  // joined
  classes?: Class
  fee_structures?: { id: string; name: string } | null
}

export interface Attendance {
  id: string
  school_id: string
  student_id: string
  scan_date: string
  scan_time: string
  entry_type: EntryType
  gate: string
  guard_id: string | null
  exam_id: string | null
  created_at: string
  // joined
  student?: Student
}


// ============================================
// LEGACY FEE TABLE (manual billing — untouched)
// ============================================

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
  period_months: string[] | null
  created_at: string
  // joined
  student?: Student
}


// ============================================
// NEW FEE MODULE TABLES
// ============================================

// fee_structures — one per class per academic year
export interface FeeStructure {
  id: string
  school_id: string
  class_id: string | null
  name: string                          // e.g. "Class 8 - 2025-26"
  academic_year: string                 // e.g. "2025-26"
  year_start_month: number              // 4 = April
  year_end_month: number                // 3 = March
  late_fee_enabled: boolean
  late_fee_type: LateFeeType | null
  late_fee_value: number
  late_fee_grace_days: number
  due_day_of_month: number              // 1-28
  is_active: boolean
  created_at: string
  updated_at: string
  // joined
  classes?: Class
  items?: FeeStructureItem[]
}

// fee_structure_items — individual line items inside a structure
export interface FeeStructureItem {
  id: string
  school_id: string
  fee_structure_id: string
  fee_type: FeeModuleType
  label: string                         // e.g. "Tuition Fee", "Lab Fee"
  amount: number
  frequency: FeeFrequency
  applicable_months: string[] | null    // for 'custom' frequency — ['2025-06','2025-10']
  quarterly_months: number[] | null     // for 'quarterly' — [4,7,10,1]
  is_enabled: boolean
  sort_order: number
  created_at: string
}

// fee_discounts — per student scholarships and discounts
export interface FeeDiscount {
  id: string
  school_id: string
  student_id: string
  label: string                         // e.g. "Merit Scholarship"
  discount_type: DiscountType
  value: number                         // % or ₹ amount
  applies_to_fee_type: FeeModuleType | null  // null = applies to all
  valid_from: string | null
  valid_until: string | null
  is_active: boolean
  notes: string | null
  created_at: string
  updated_at: string
  // joined
  student?: Student
}

// fee_dues — auto-generated monthly dues per student
export interface FeeDue {
  id: string
  school_id: string
  student_id: string
  fee_structure_id: string
  fee_structure_item_id: string
  fee_type: FeeModuleType
  label: string
  month: string                         // 'YYYY-MM' e.g. '2025-06'
  academic_year: string
  due_date: string                      // DATE
  base_amount: number
  discount_amount: number
  net_amount: number
  late_fee_amount: number
  total_due: number
  amount_paid: number
  balance: number                       // generated column: total_due - amount_paid
  status: DueStatus
  late_fee_applied: boolean
  waiver_reason: string | null
  notes: string | null
  created_at: string
  updated_at: string
  // joined
  student?: Student
  payments?: FeePayment[]
}

// fee_payments — actual money collected against a due
export interface FeePayment {
  id: string
  school_id: string
  student_id: string
  fee_due_id: string
  amount_paid: number
  payment_method: PaymentMethod
  receipt_number: string | null
  paid_date: string                     // DATE
  collected_by: string | null           // profile id
  notes: string | null
  created_at: string
  // joined
  due?: FeeDue
  collector?: Profile
}


// ============================================
// RPC RETURN TYPES
// These match the RETURNS TABLE definitions
// in the SQL functions exactly
// ============================================

// get_student_fee_ledger() return type
export interface StudentFeeLedgerRow {
  due_id: string
  fee_type: FeeModuleType
  label: string
  month: string
  academic_year: string
  due_date: string
  base_amount: number
  discount_amount: number
  net_amount: number
  late_fee_amount: number
  total_due: number
  amount_paid: number
  balance: number
  status: DueStatus
  payments_count: number
  last_payment_date: string | null
  last_receipt: string | null
}

// get_defaulters() return type
export interface DefaulterRow {
  student_id: string
  full_name: string
  student_uid: string | null
  class_name: string | null
  class_section: string | null
  total_balance: number
  oldest_due_date: string
  days_overdue: number
  dues_count: number
}

// get_fee_dashboard_stats() return type
export interface FeeDashboardStats {
  today_collection: number
  month_collection: number
  total_pending: number
  defaulters_count: number
  total_collected_ytd: number
}

// generate_fee_dues() return type
export interface GenerateDuesResult {
  generated_count: number
  skipped_count: number
}

// record_fee_payment() return type
export interface RecordPaymentResult {
  payment_id: string
  receipt_number: string
}


// ============================================
// UI / PAGE HELPER TYPES
// ============================================

// For the fee collection form
export interface CollectFeeForm {
  fee_due_id: string
  amount_paid: number
  payment_method: PaymentMethod
  paid_date: string
  notes: string
}

// For the fee structure builder form
export interface FeeStructureForm {
  name: string
  class_id: string
  academic_year: string
  year_start_month: number
  year_end_month: number
  due_day_of_month: number
  late_fee_enabled: boolean
  late_fee_type: LateFeeType
  late_fee_value: number
  late_fee_grace_days: number
  items: FeeStructureItemForm[]
}

export interface FeeStructureItemForm {
  fee_type: FeeModuleType
  label: string
  amount: number
  frequency: FeeFrequency
  applicable_months: string[]
  quarterly_months: number[]
  is_enabled: boolean
  sort_order: number
}

// Class-wise fee summary (for reports page)
export interface ClassFeeSummary {
  class_id: string
  class_name: string
  class_section: string | null
  total_students: number
  total_expected: number
  total_collected: number
  total_pending: number
  collection_percentage: number
}

// ============================================
// LEGACY DASHBOARD TYPES (kept for compatibility)
// ============================================

export interface DashboardStats {
  totalStudents: number
  totalFeesCollected: number
  totalFeesPending: number
  totalClasses: number
}

export interface AttendanceSummary {
  date: string
  total_present: number
  total_students: number
  attendance_rate: number
}
