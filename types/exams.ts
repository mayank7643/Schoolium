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

export type ResultStatus = 'pass' | 'fail' | 'withheld' | 'absent'
export type PublicationStatus = 'unpublished' | 'scheduled' | 'published' | 'locked'

export interface ResultPublication {
  id: string
  school_id: string
  exam_id: string
  status: PublicationStatus
  scheduled_for: string | null
  published_at: string | null
  published_by: string | null
  unpublished_at: string | null
  unpublished_by: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface PublicResultExam { exam_id: string; exam_name: string; session_name: string }

export interface PublicResultCheck {
  found: boolean
  reason?: 'not_published' | 'no_match'
  report?: ReportCardSnapshot
}

export interface ReportCardVerify {
  valid: boolean
  reason?: 'not_found' | 'not_published'
  version_status?: 'current' | 'superseded'
  student_name?: string
  class?: string
  exam_name?: string
  percentage?: string
  result?: string
  generated_at?: string
}

export interface GradeScale {
  id: string
  school_id: string
  session_id: string | null
  name: string
  is_default: boolean
  is_active: boolean
  created_at: string
}

export interface GradeBand {
  id: string
  school_id: string
  grade_scale_id: string
  min_percent: number
  max_percent: number
  grade_label: string
  grade_point: number | null
  is_fail: boolean
  description: string | null
}

export interface ExamResult {
  id: string
  school_id: string
  exam_id: string
  student_id: string
  enrollment_id: string
  grade_scale_id: string | null
  total_max: number
  total_obtained: number
  percentage: number
  grade_label: string | null
  grade_point: number | null
  subjects_failed: number
  result_status: ResultStatus
  rank_in_class: number | null
  attendance_percent: number | null
  is_final: boolean
  computed_by: string | null
  computed_at: string
}

export interface ReportCard {
  id: string
  school_id: string
  session_id: string
  exam_id: string | null
  term_id: string | null
  student_id: string
  snapshot: ReportCardSnapshot
  class_teacher_remarks: string | null
  qr_token: string
  version: number
  generated_by: string | null
  generated_at: string
}

export interface ReportCardSnapshot {
  school: { name: string; address: string | null; logo_url: string | null }
  exam: { name: string }
  student: { full_name: string; student_uid: string | null; photo_url: string | null; roll_number: number; class: string }
  result: {
    total_max: number; total_obtained: number; percentage: number
    grade: string | null; cgpa: number | null; status: ResultStatus
    rank: number | null; attendance_percent: number | null; subjects_failed: number
  }
  subjects: Array<{
    subject: string; max: number; theory: number | null; practical: number | null
    internal: number | null; grace: number | null; total: number | null
    pass_marks: number; is_absent: boolean; grade: string | null
  }>
  remarks?: string
}

export interface ComputeResultsResult { computed: number; withheld: number }
export interface GenerateReportCardsResult { generated: number }

export interface ClassResultSummaryRow {
  class_id: string
  class_label: string
  students: number
  average_pct: number
  pass_count: number
  fail_count: number
  pass_pct: number
  topper_name: string | null
  topper_pct: number | null
}

export type SubmissionStatus = 'pending' | 'submitted' | 'verified' | 'approved' | 'frozen' | 'rejected'

export interface MarksSubmission {
  id: string
  school_id: string
  exam_subject_id: string
  status: SubmissionStatus
  submitted_by: string | null
  submitted_at: string | null
  verified_by: string | null
  verified_at: string | null
  approved_by: string | null
  approved_at: string | null
  frozen_at: string | null
  rejection_reason: string | null
  created_at: string
  updated_at: string
}

export interface MarksGridRow {
  student_id: string
  roll_number: number
  full_name: string
  photo_url: string | null
  enroll_status: EnrollmentStatus
  session_exempted: boolean
  room_status: ExamAttStatus | null
  theory: number | null
  practical: number | null
  internal: number | null
  grace: number | null
  is_absent: boolean
  is_exempted: boolean
  total: number | null
}

export interface MarksGridData {
  status: SubmissionStatus
  max_theory: number
  max_practical: number
  max_internal: number
  pass_marks: number
  total_max: number
  can_edit: boolean
  rows: MarksGridRow[]
}

export interface MarksBoardRow {
  exam_subject_id: string
  class_label: string
  subject_name: string
  status: SubmissionStatus
  entered: number
  enrolled: number
  submitted_at: string | null
  updated_at: string | null
}

export interface SaveMarksResult {
  saved: number
  rejected: Array<{ student_id: string; reason: string }>
}

export type ExamAttStatus = 'present' | 'absent' | 'medical' | 'late'
export type ExamAttSource = 'qr' | 'manual'

export interface ExamAttendance {
  id: string
  school_id: string
  exam_subject_id: string
  student_id: string
  status: ExamAttStatus
  source: ExamAttSource
  remarks: string | null
  marked_by: string | null
  marked_at: string
  created_at: string
  updated_at: string
}

// ── RPC payloads / results (match RETURNS exactly) ──────────────

export interface ExamAttendanceScanResult {
  ok: boolean
  reason?: 'unknown_card' | 'revoked_card' | 'wrong_exam' | 'wrong_class'
  status_set?: ExamAttStatus
  student_name?: string
  photo_url?: string | null
  roll_number?: number
  seat_number?: string | null
  class_label?: string
  subject_name?: string
  warnings?: string[]
}

export interface ExamAttendanceReportRow {
  exam_subject_id: string
  class_label: string
  subject_name: string
  exam_date: string | null
  enrolled: number
  present: number
  late: number
  absent: number
  medical: number
  unmarked: number
}

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
