// ============================================
// SCHOOLIUM — DATABASE TYPES
// Matches the Supabase schema exactly
// ============================================

export type Plan           = 'basic' | 'standard' | 'premium'
export type Role           = 'super_admin' | 'school_admin' | 'operator' | 'principal' | 'teacher' | 'collector' | 'receptionist' | 'staff' | 'guard' | 'parent'
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
  // WhatsApp feature gates (each independent)
  wa_alerts_enabled: boolean               // attendance entry/exit/absence alerts
  wa_fee_reminders_enabled: boolean         // fee due + overdue reminders
  wa_payment_confirmation_enabled: boolean  // on-payment WhatsApp + PDF receipt
  fee_reminder_days_before: number          // days before due_date to remind (default 3)
  wa_monthly_quota: number
  wa_messages_sent_month: number
  wa_quota_reset_date: string | null
  // Late-fee waiver caps
  late_fee_waiver_max_pct: number
  late_fee_waiver_max_flat: number
  admin_override_pin: string | null
  // Alerts BYOG pipeline (chat21) — independent of the legacy wa_* gates
  alerts_enabled: boolean
  alerts_timezone: string
  absent_cutoff_time: string | null        // 'HH:MM:SS', null = absence alerts off
  checkout_alerts_enabled: boolean
  quiet_hours_start: string
  quiet_hours_end: string
  stale_alert_minutes: number | null
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
  external_ref: string | null        // the school ERP's student id (CSV upsert key, chat21)
  class_label: string | null         // free-text class filter, e.g. "5-A" (chat21)
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


// ============================================
// STAFF MANAGEMENT MODULE (chat17)
// ============================================

export type EmploymentStatus   = 'active' | 'probation' | 'on_leave' | 'resigned' | 'terminated' | 'retired'
export type BloodGroup         = 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-'
export type StaffAttStatus     = 'present' | 'absent' | 'late' | 'half_day' | 'leave'
export type StaffAttSource     = 'manual' | 'qr' | 'leave_sync' | 'biometric'
export type LeaveType          = 'casual' | 'sick' | 'earned' | 'unpaid' | 'other'
export type LeaveStatus        = 'pending' | 'approved' | 'rejected' | 'cancelled'
export type StaffDocType       = 'aadhaar' | 'pan' | 'resume' | 'qualification' | 'appointment_letter' | 'other'

export interface Staff {
  id: string
  school_id: string
  profile_id: string
  employee_id: string
  full_name: string
  father_name: string | null
  mobile: string
  email: string
  address: string | null
  date_of_birth: string | null
  gender: Gender | null
  blood_group: BloodGroup | null
  qualification: string | null
  experience_years: number
  joining_date: string
  employment_status: EmploymentStatus
  department: string
  designation: string
  is_teaching: boolean
  photo_url: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface Subject {
  id: string
  school_id: string
  name: string
  code: string | null
  is_active: boolean
  created_at: string
}

export interface ClassTeacher {
  id: string
  school_id: string
  class_id: string
  staff_id: string
  created_by: string | null
  created_at: string
  // joined
  classes?: Class
  staff?: Staff
}

export interface SubjectAssignment {
  id: string
  school_id: string
  staff_id: string
  subject_id: string
  class_id: string
  created_by: string | null
  created_at: string
  // joined
  subjects?: Subject
  classes?: Class
  staff?: Staff
}

export interface StaffAttendance {
  id: string
  school_id: string
  staff_id: string
  attendance_date: string
  status: StaffAttStatus
  check_in_time: string | null
  check_out_time: string | null
  source: StaffAttSource
  remarks: string | null
  marked_by: string | null
  created_at: string
  updated_at: string
  // joined
  staff?: Staff
}

export interface LeaveRequest {
  id: string
  school_id: string
  staff_id: string
  leave_type: LeaveType
  from_date: string
  to_date: string
  total_days: number
  reason: string
  document_path: string | null
  status: LeaveStatus
  admin_comment: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  updated_at: string
  // joined
  staff?: Staff
}

export interface StaffDocument {
  id: string
  school_id: string
  staff_id: string
  doc_type: StaffDocType
  title: string
  file_path: string
  file_size: number | null
  uploaded_by: string | null
  created_at: string
}

export interface RolePermission {
  id: string
  school_id: string | null
  role: string
  permission_key: string
  allowed: boolean
  created_at: string
}

// get_staff_directory_basic() row - safe columns only
export interface StaffDirectoryEntry {
  id: string
  employee_id: string
  full_name: string
  designation: string
  department: string
  is_teaching: boolean
  photo_url: string | null
}

// get_teacher_assignments() shape
export interface TeacherAssignments {
  class_teacher_of: { class_id: string; name: string; section: string | null }[]
  subjects: {
    assignment_id: string
    subject_id: string
    subject: string
    class_id: string
    class_name: string
    section: string | null
  }[]
}

// get_staff_attendance_summary() row
export interface StaffAttendanceSummaryRow {
  staff_id: string
  employee_id: string
  full_name: string
  department: string
  designation: string
  present_days: number
  late_days: number
  half_days: number
  absent_days: number
  leave_days: number
  working_days: number
  percentage: number
}

// get_staff_dashboard_stats() shape
export interface StaffDashboardStats {
  total_staff: number
  teaching_staff: number
  non_teaching_staff: number
  today: {
    present: number
    late: number
    half_day: number
    absent: number
    on_leave: number
    unmarked: number
  }
  pending_leave_requests: number
}

// ============================================
// TEACHER WORKSPACE (chat18)
// ============================================

export type ClassAttStatus = 'present' | 'absent' | 'late'

export interface ClassAttendance {
  id: string
  school_id: string
  class_id: string
  student_id: string
  attendance_date: string
  status: ClassAttStatus
  source: 'teacher' | 'admin'
  marked_by: string | null
  created_at: string
  updated_at: string
}

// get_class_fee_summary() row - read-only view for class teachers
export interface ClassFeeSummaryRow {
  student_id: string
  full_name: string
  total_due: number
  total_paid: number
  balance: number
  overdue_count: number
}


// ============================================
// ALERTS BYOG PIPELINE (chat21)
// docs/schoolium-alerts-blueprint.md
// ============================================

export type AlertChannel        = 'sms' | 'whatsapp' | 'email'
export type TemplateCategory    = 'utility' | 'marketing' | 'service' | 'transactional'
export type ApprovalStatus      = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paused'
export type OutboxStatus        = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'dead'
export type ChannelHealth       = 'unverified' | 'ok' | 'auth_failed' | 'low_balance' | 'suspended'
export type ChannelProvider     = 'meta_cloud' | 'msg91' | 'gupshup' | 'generic_http' | 'smtp' | 'fake'
export type AlertEventType      = 'student.checked_in' | 'student.checked_out' | 'student.absent_at_cutoff' | 'notice.published'
export type NotificationKind    = 'spend_cap_hit' | 'stale_suppressed' | 'enqueue_error' | 'channel_unhealthy' | 'low_balance' | 'absent_skipped_no_scans'
export type ImportBatchStatus   = 'uploaded' | 'validated' | 'applied' | 'discarded'
export type ImportRowAction     = 'new' | 'update' | 'unchanged' | 'remove' | 'invalid'

export interface Guardian {
  id: string
  school_id: string
  full_name: string | null
  created_at: string
}

export interface StudentGuardian {
  student_id: string
  guardian_id: string
  relation: string | null
  is_primary: boolean
}

export interface ContactMethod {
  id: string
  guardian_id: string
  channel: AlertChannel
  value: string                       // E.164 for phones: +919876543210
  opted_out: boolean
  created_at: string
}

export interface AlertEvent {
  id: number
  school_id: string
  type: AlertEventType
  subject_id: string | null           // student_id, null for notices
  occurred_at: string                 // ORIGINAL scan time, never sync time
  payload: Record<string, unknown>
  dedup_key: string | null
  created_at: string
}

export interface MessageTemplate {
  id: string
  school_id: string
  key: string                         // 'checkin' | 'checkout' | 'absent' | 'notice*'
  body: string                        // "{{child}} entered {{school}} at {{time}}."
  created_at: string
}

export interface ChannelTemplate {
  id: string
  school_id: string
  message_template_id: string
  channel: AlertChannel
  category: TemplateCategory
  provider_template_id: string | null // DLT template id / Meta template name
  header: string | null               // DLT sender header
  language: string | null
  var_map: Record<string, string>     // {"1":"child","2":"school","3":"time"}
  approval_status: ApprovalStatus
  approved_at: string | null
  created_at: string
  updated_at: string
}

export interface MessageOutbox {
  id: number
  school_id: string
  event_id: number | null
  channel_template_id: string
  channel: AlertChannel
  recipient: string
  vars: Record<string, string>
  status: OutboxStatus
  attempts: number
  next_attempt_at: string
  provider_message_id: string | null
  error_code: string | null
  error_message: string | null
  cost_estimate_paise: number
  idempotency_key: string
  triggered_by: 'scan' | 'cutoff' | 'composer' | 'test' | 'system'
  sent_by_user_id: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

export interface RateCard {
  channel: AlertChannel
  category: TemplateCategory
  paise: number
  gst_pct: number
  effective_from: string
}

export interface SpendGuard {
  school_id: string
  daily_cap_paise: number
  spent_today_paise: number
  spent_date: string
}

// school_channels (credential vault) is service-role only and never
// reaches the client. The UI-safe projection is fingerprint + health:
export interface SchoolChannelSummary {
  id: string
  school_id: string
  channel: AlertChannel
  provider: ChannelProvider
  health: ChannelHealth
  last_verified_at: string | null
  balance_hint_paise: number | null
  secret_fingerprint_last6: string
}

export interface AbsentRun {
  school_id: string
  run_date: string
  emitted_count: number
  created_at: string
}

export interface AlertNotification {
  id: number
  school_id: string
  kind: NotificationKind
  severity: 'info' | 'warning' | 'error'
  message: string
  context: Record<string, unknown>
  dedup_key: string | null
  is_read: boolean
  created_at: string
}

export interface ImportBatch {
  id: string
  school_id: string
  uploaded_by: string | null
  filename: string | null
  status: ImportBatchStatus
  summary: { new?: number; removed?: number; changed?: number; unchanged?: number; invalid?: number }
  created_at: string
  applied_at: string | null
}

export interface ImportRow {
  id: number
  batch_id: string
  row_number: number
  external_ref: string | null
  student_name: string | null
  class_label: string | null
  guardian_name: string | null
  guardian_phone: string | null
  guardian_email: string | null
  guardian2_phone: string | null
  raw: Record<string, unknown>
  validation_errors: string[]
  action: ImportRowAction | null
  created_at: string
}

// publish_notice() RPC result
export interface PublishNoticeResult {
  event_id: number
  notice_id: string
  queued: number
}

// estimate_notice_send() RPC row
export interface NoticeEstimate {
  recipient_count: number
  est_cost_paise: number
}

// get_notice_delivery_stats() RPC row
export interface NoticeDeliveryStats {
  n_total: number
  n_queued: number
  n_sent: number
  n_delivered: number
  n_read: number
  n_failed: number
  n_dead: number
  cost_paise: number
}
