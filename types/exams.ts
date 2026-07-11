// ============================================
// SCHOOLIUM — EXAM MODULE TYPES (chat21, Phase 1)
// Matches supabase/migrations/20260708120000_exam_sessions_core.sql exactly
// ============================================

import type { Class, Subject, Student } from './index'

export type SessionStatus     = 'upcoming' | 'active' | 'locked' | 'archived'
export type TermType          = 'term' | 'semester'
export type ExamTypeCategory  = 'unit_test' | 'monthly' | 'quarterly' | 'half_yearly' | 'annual' | 'practical' | 'custom'
export type ExamStatus        = 'draft' | 'published' | 'ongoing' | 'completed' | 'locked' | 'cancelled'
export type EnrollmentStatus  = 'enrolled' | 'exempted' | 'withdrawn' | 'transferred'
export type OverrideKind      = 'exempted' | 'optional_selected'
export type IssueSeverity     = 'error' | 'warning'

export interface AcademicSession {
  id: string
  school_id: string
  name: string
  start_date: string
  end_date: string
  status: SessionStatus
  is_current: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AcademicTerm {
  id: string
  school_id: string
  session_id: string
  name: string
  term_type: TermType
  sort_order: number
  start_date: string
  end_date: string
  weightage_percent: number
  created_at: string
  updated_at: string
}

export interface ExamType {
  id: string
  school_id: string
  name: string
  code: string | null
  category: ExamTypeCategory
  default_weightage: number
  is_active: boolean
  created_at: string
}

export interface ExamRoom {
  id: string
  school_id: string
  name: string
  capacity: number | null
  location: string | null
  is_active: boolean
  created_at: string
}

export interface Exam {
  id: string
  school_id: string
  session_id: string
  term_id: string | null
  exam_type_id: string
  name: string
  status: ExamStatus
  start_date: string | null
  end_date: string | null
  general_instructions: string | null
  published_at: string | null
  locked_at: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  // joined
  exam_types?: Pick<ExamType, 'name' | 'code' | 'category'> | null
  academic_terms?: Pick<AcademicTerm, 'name'> | null
  academic_sessions?: Pick<AcademicSession, 'name'> | null
}

export interface ExamClass {
  id: string
  school_id: string
  exam_id: string
  class_id: string
  created_at: string
  // joined
  classes?: Class
}

export interface ExamSubject {
  id: string
  school_id: string
  exam_id: string
  class_id: string
  subject_id: string
  max_marks_theory: number
  max_marks_practical: number
  max_marks_internal: number
  total_max_marks: number
  pass_marks: number
  weightage_percent: number
  is_optional: boolean
  is_cancelled: boolean
  exam_date: string | null
  start_time: string | null
  reporting_time: string | null
  duration_minutes: number | null
  room_id: string | null
  instructions: string | null
  created_at: string
  updated_at: string
  // joined
  classes?: Class
  subjects?: Subject
  exam_rooms?: Pick<ExamRoom, 'name'> | null
}

export interface ExamEnrollment {
  id: string
  school_id: string
  exam_id: string
  student_id: string
  class_id: string
  roll_number: number
  room_id: string | null
  seat_number: string | null
  status: EnrollmentStatus
  remarks: string | null
  created_at: string
  updated_at: string
  // joined
  students?: Pick<Student, 'full_name' | 'photo_url' | 'student_uid'>
  classes?: Class
}

export interface StudentSubjectOverride {
  id: string
  school_id: string
  session_id: string
  student_id: string
  subject_id: string
  kind: OverrideKind
  reason: string | null
  created_by: string | null
  created_at: string
  // joined
  students?: Pick<Student, 'full_name'>
  subjects?: Pick<Subject, 'name'>
}

export interface ExamAuditLog {
  id: string
  school_id: string
  entity_type: string
  entity_id: string | null
  action: string
  old_values: Record<string, unknown> | null
  new_values: Record<string, unknown> | null
  actor_id: string | null
  reason: string | null
  created_at: string
}

export interface Holiday {
  id: string
  school_id: string
  session_id: string
  holiday_date: string
  name: string
  created_by: string | null
  created_at: string
}

export type AdmitCardLayout = 'single' | 'two_per_a4' | 'three_per_a4' | 'four_per_a4'

export interface AdmitCardTemplate {
  id: string
  school_id: string
  name: string
  layout: AdmitCardLayout
  instructions: string | null
  principal_signature_path: string | null
  show_photo: boolean
  show_qr: boolean
  show_seat: boolean
  is_default: boolean
  created_at: string
}

export interface AdmitCard {
  id: string
  school_id: string
  exam_id: string
  enrollment_id: string
  template_id: string | null
  qr_token: string
  is_revoked: boolean
  revoke_reason: string | null
  print_count: number
  last_printed_at: string | null
  generated_by: string | null
  created_at: string
  // joined
  exam_enrollments?: ExamEnrollment
}

export type QuestionPaperStatus = 'draft' | 'final'
export type QpAccessAction = 'upload' | 'download' | 'lock' | 'unlock'

export interface QuestionPaper {
  id: string
  school_id: string
  exam_subject_id: string
  status: QuestionPaperStatus
  current_version_id: string | null
  locked_by: string | null
  locked_at: string | null
  created_at: string
  updated_at: string
}

export interface QuestionPaperVersion {
  id: string
  school_id: string
  question_paper_id: string
  version_no: number
  file_path: string
  file_size: number | null
  note: string | null
  uploaded_by: string | null
  created_at: string
}

export interface QuestionPaperAccessLog {
  id: string
  school_id: string
  question_paper_id: string
  version_id: string | null
  profile_id: string | null
  action: QpAccessAction
  created_at: string
  // joined
  profiles?: { full_name: string } | null
}

// ── RPC payloads / results (match RETURNS exactly) ──────────────

export interface RegisterQpUploadResult {
  question_paper_id: string
  version_id: string
  version_no: number
  file_path: string
}

export interface GenerateAdmitCardsResult {
  generated: number
  total_live: number
}

export interface VerifyAdmitCardResult {
  valid: boolean
  reason?: 'not_found' | 'revoked' | 'exempted' | 'withdrawn' | 'transferred'
  student_name?: string
  photo_url?: string | null
  roll_number?: number
  seat_number?: string | null
  class_label?: string
  exam_name?: string
  exam_status?: ExamStatus
}

export interface TimetableIssue {
  severity: IssueSeverity
  code: 'MISSING_SCHEDULE' | 'CLASS_OVERLAP' | 'SAME_DAY_LOAD' | string
  exam_subject_id: string
  class_label: string
  subject_name: string
  message: string
}

export interface PublishExamResult {
  status: 'published'
  enrolled: number
  total: number
}

export interface GenerateEnrollmentsResult {
  enrolled: number
  total: number
}

export interface UpsertExamSubjectsResult {
  saved: number
}

export interface AutoGenerateTimetableResult {
  scheduled: number
  unscheduled: number
}

// Row shape accepted by upsert_exam_subjects (draft mode sends all
// fields; published mode must send schedule fields only)
export interface ExamSubjectRowInput {
  class_id: string
  subject_id: string
  max_marks_theory?: number
  max_marks_practical?: number
  max_marks_internal?: number
  pass_marks?: number
  weightage_percent?: number
  is_optional?: boolean
  exam_date?: string | null
  start_time?: string | null
  reporting_time?: string | null
  duration_minutes?: number | null
  room_id?: string | null
  instructions?: string | null
}
