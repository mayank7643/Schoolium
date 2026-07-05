-- ============================================================
-- SCHOOLIUM - CHAT 17 SESSION - FINAL CONSOLIDATED MIGRATION
-- staff_management_full  (supersedes: chat17, chat17b, chat18, chat19)
-- Generated 05 July 2026 - validated end-to-end on PostgreSQL 16
-- ============================================================
-- Contains ONLY database changes from this chat session, final
-- versions only. Assumes chat02..chat16 are already applied.
-- Idempotent: IF NOT EXISTS / DROP POLICY IF EXISTS /
-- CREATE OR REPLACE throughout - safe to run on a database where
-- the four originals were already applied (it is a no-op there)
-- OR on a fresh post-chat16 database.
--
-- PART 1  Staff management core        (was chat17 + chat17b)
--         roles, staff/subjects/assignments/attendance/leave/
--         documents/login-history/permissions schema, helpers,
--         triggers, RLS, staff-docs bucket WITH upload caps,
--         12 RPCs, permission seeds, login-history purge cron
-- PART 2  Teacher workspace            (was chat18)
--         class_attendance (roll call), is_class_teacher_of,
--         mark_class_attendance, get_class_fee_summary
-- PART 3  Security hardening           (was chat19)
--         teaches_in_class + students/classes/schools RLS
--         lockdown (closes privilege-escalation holes)
-- PART 4  Single PostgREST schema reload
--
-- Rules honoured: pure ASCII, CREATE OR REPLACE (never drop and
-- recreate same-signature functions), every SECURITY DEFINER sets
-- search_path + verifies auth.uid() role/school + REVOKE ALL FROM
-- PUBLIC + GRANT EXECUTE, school_id isolation everywhere,
-- profiles RLS untouched.
-- ============================================================


-- ##################################################################
-- PART 1: STAFF MANAGEMENT CORE (chat17 + chat17b merged)
-- Sections 1-11 below. The staff-docs bucket statement carries the
-- chat17b upload caps directly (500 KB, PDF/JPG/PNG/WebP).
-- ##################################################################

-- ============================================================
-- SECTION 1: profiles - role CHECK + last_login_at
-- Existing roles kept byte-for-byte; three added.
-- Mapping: Accountant = collector (existing). Vice Principal =
-- principal system role + designation. Librarian / Transport
-- Manager / other non-teaching = staff system role + designation.
-- ============================================================

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN (
      'super_admin',
      'school_admin',
      'principal',
      'teacher',
      'collector',
      'receptionist',
      'staff',
      'guard',
      'parent'
    ));

COMMENT ON COLUMN public.profiles.role IS
  'super_admin: platform staff. '
  'school_admin: owner - full access. '
  'principal: full academic access (also used for vice principal designation). '
  'teacher: assigned classes and subjects. '
  'collector: fee collection (accountant). '
  'receptionist: admissions and student management. '
  'staff: generic non-teaching staff (librarian, transport manager, etc). '
  'guard: gate scan only. '
  'parent: reserved.';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;


-- ============================================================
-- SECTION 2: schools - employee number counter + late cutoff
-- ============================================================

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS staff_id_seq integer NOT NULL DEFAULT 0;

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS staff_late_after_time time NOT NULL DEFAULT '09:15:00';

COMMENT ON COLUMN public.schools.staff_id_seq IS
  'Per-school monotonic counter for employee IDs (EMP-NNNN). '
  'Incremented under row lock inside create_staff_member() only.';

COMMENT ON COLUMN public.schools.staff_late_after_time IS
  'QR staff check-in after this local time (Asia/Kolkata) is marked late.';


-- ============================================================
-- SECTION 3: TABLES
-- ============================================================

-- ------------------------------------------------------------
-- staff - HR record. One per staff member. profile_id is NOT NULL
-- because every staff member has a login (product decision).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff (
  id                 uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id          uuid          NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  profile_id         uuid          NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE RESTRICT,
  employee_id        text          NOT NULL,
  full_name          text          NOT NULL,
  father_name        text,
  mobile             text          NOT NULL,
  email              text          NOT NULL,
  address            text,
  date_of_birth      date,
  gender             text          CHECK (gender IN ('male', 'female', 'other')),
  blood_group        text          CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  qualification      text,
  experience_years   numeric(4,1)  NOT NULL DEFAULT 0 CHECK (experience_years >= 0),
  joining_date       date          NOT NULL DEFAULT current_date,
  employment_status  text          NOT NULL DEFAULT 'active'
                                   CHECK (employment_status IN
                                     ('active','probation','on_leave','resigned','terminated','retired')),
  department         text          NOT NULL DEFAULT 'Teaching',
  designation        text          NOT NULL,
  is_teaching        boolean       NOT NULL DEFAULT false,
  photo_url          text,
  created_by         uuid          REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_employee_id UNIQUE (school_id, employee_id)
);

COMMENT ON TABLE public.staff IS
  'HR master record. Future payroll / PF / ESI / reviews reference staff.id. '
  'Sensitive columns (dob, mobile, address) - SELECT restricted to admin/principal/self; '
  'colleague listings must use get_staff_directory_basic().';

-- ------------------------------------------------------------
-- subjects - per school subject catalogue
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subjects (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  code        text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_subjects_name UNIQUE (school_id, name)
);

-- ------------------------------------------------------------
-- class_teachers - class teacher M2M (many teachers per class,
-- many classes per teacher, both allowed)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.class_teachers (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  class_id    uuid        NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  staff_id    uuid        NOT NULL REFERENCES public.staff(id)   ON DELETE CASCADE,
  created_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_class_teachers UNIQUE (class_id, staff_id)
);

-- ------------------------------------------------------------
-- subject_assignments - teacher x subject x class
-- (Amit Sir: Maths->5A, Maths->5B, Maths->6A = three rows)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subject_assignments (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  staff_id    uuid        NOT NULL REFERENCES public.staff(id)    ON DELETE CASCADE,
  subject_id  uuid        NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  class_id    uuid        NOT NULL REFERENCES public.classes(id)  ON DELETE CASCADE,
  created_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_subject_assignments UNIQUE (staff_id, subject_id, class_id)
);

-- ------------------------------------------------------------
-- staff_attendance - one row per staff per day (status based;
-- completely separate from the student scan table 'attendance')
-- source is future-ready: biometric / face recognition become
-- new source values with zero refactor.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_attendance (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id        uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  staff_id         uuid        NOT NULL REFERENCES public.staff(id)   ON DELETE CASCADE,
  attendance_date  date        NOT NULL,
  status           text        NOT NULL
                               CHECK (status IN ('present','absent','late','half_day','leave')),
  check_in_time    time,
  check_out_time   time,
  source           text        NOT NULL DEFAULT 'manual'
                               CHECK (source IN ('manual','qr','leave_sync','biometric')),
  remarks          text,
  marked_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_attendance_day UNIQUE (school_id, staff_id, attendance_date),
  CONSTRAINT ck_staff_attendance_out_after_in
    CHECK (check_out_time IS NULL OR check_in_time IS NULL OR check_out_time >= check_in_time)
);

-- ------------------------------------------------------------
-- leave_requests - all writes go through RPCs (apply / cancel /
-- review). total_days is generated - never written directly.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.leave_requests (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id      uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  staff_id       uuid        NOT NULL REFERENCES public.staff(id)   ON DELETE CASCADE,
  leave_type     text        NOT NULL DEFAULT 'casual'
                             CHECK (leave_type IN ('casual','sick','earned','unpaid','other')),
  from_date      date        NOT NULL,
  to_date        date        NOT NULL,
  total_days     integer     GENERATED ALWAYS AS (to_date - from_date + 1) STORED,
  reason         text        NOT NULL,
  document_path  text,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','approved','rejected','cancelled')),
  admin_comment  text,
  reviewed_by    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_leave_dates CHECK (to_date >= from_date)
);

-- ------------------------------------------------------------
-- staff_documents - HR document registry (files live in the
-- private staff-docs storage bucket; this row stores the path)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_documents (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id    uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  staff_id     uuid        NOT NULL REFERENCES public.staff(id)   ON DELETE CASCADE,
  doc_type     text        NOT NULL
                           CHECK (doc_type IN
                             ('aadhaar','pan','resume','qualification','appointment_letter','other')),
  title        text        NOT NULL,
  file_path    text        NOT NULL,
  file_size    integer,
  uploaded_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- login_history - optional audit trail (purged after 180 days)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.login_history (
  id            uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id     uuid        REFERENCES public.schools(id) ON DELETE CASCADE,
  profile_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  logged_in_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text
);

-- ------------------------------------------------------------
-- role_permissions - permission matrix. school_id NULL rows are
-- global defaults; a school row overrides the global row for the
-- same (role, permission_key). Custom-role ready: a future custom
-- role only needs rows here plus a value in the profiles CHECK.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.role_permissions (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id       uuid        REFERENCES public.schools(id) ON DELETE CASCADE,
  role            text        NOT NULL,
  permission_key  text        NOT NULL,
  allowed         boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- NULLs are distinct in plain UNIQUE - enforce with two partial indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_permissions_global
  ON public.role_permissions (role, permission_key)
  WHERE school_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_role_permissions_school
  ON public.role_permissions (school_id, role, permission_key)
  WHERE school_id IS NOT NULL;


-- ============================================================
-- SECTION 4: INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_staff_school            ON public.staff(school_id);
CREATE INDEX IF NOT EXISTS idx_staff_profile           ON public.staff(profile_id);
CREATE INDEX IF NOT EXISTS idx_staff_school_status     ON public.staff(school_id, employment_status);
CREATE INDEX IF NOT EXISTS idx_subjects_school         ON public.subjects(school_id);
CREATE INDEX IF NOT EXISTS idx_class_teachers_school   ON public.class_teachers(school_id);
CREATE INDEX IF NOT EXISTS idx_class_teachers_staff    ON public.class_teachers(staff_id);
CREATE INDEX IF NOT EXISTS idx_class_teachers_class    ON public.class_teachers(class_id);
CREATE INDEX IF NOT EXISTS idx_subject_assign_school   ON public.subject_assignments(school_id);
CREATE INDEX IF NOT EXISTS idx_subject_assign_staff    ON public.subject_assignments(staff_id);
CREATE INDEX IF NOT EXISTS idx_subject_assign_class    ON public.subject_assignments(class_id);
CREATE INDEX IF NOT EXISTS idx_staff_att_school_date   ON public.staff_attendance(school_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_staff_att_staff_date    ON public.staff_attendance(staff_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_leave_req_school_status ON public.leave_requests(school_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_req_staff         ON public.leave_requests(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_docs_staff        ON public.staff_documents(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_docs_school       ON public.staff_documents(school_id);
CREATE INDEX IF NOT EXISTS idx_login_history_school    ON public.login_history(school_id, logged_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_history_profile   ON public.login_history(profile_id, logged_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_role_permissions_lookup ON public.role_permissions(role, permission_key);


-- ============================================================
-- SECTION 5: TRIGGERS
-- ============================================================

-- ------------------------------------------------------------
-- Generic updated_at setter
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_staff_updated_at ON public.staff;
CREATE TRIGGER trg_staff_updated_at
  BEFORE UPDATE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP TRIGGER IF EXISTS trg_staff_att_updated_at ON public.staff_attendance;
CREATE TRIGGER trg_staff_att_updated_at
  BEFORE UPDATE ON public.staff_attendance
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP TRIGGER IF EXISTS trg_leave_req_updated_at ON public.leave_requests;
CREATE TRIGGER trg_leave_req_updated_at
  BEFORE UPDATE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ------------------------------------------------------------
-- Keep profiles.full_name / phone in sync when HR edits staff.
-- SECURITY DEFINER because the editor (admin) cannot update other
-- users' profiles rows under profiles RLS (which we never modify).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_sync_staff_to_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.full_name IS DISTINCT FROM OLD.full_name)
     OR (NEW.mobile IS DISTINCT FROM OLD.mobile) THEN
    UPDATE public.profiles
    SET full_name = NEW.full_name,
        phone     = NEW.mobile
    WHERE id = NEW.profile_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_staff_profile ON public.staff;
CREATE TRIGGER trg_sync_staff_profile
  AFTER UPDATE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.tg_sync_staff_to_profile();

-- ------------------------------------------------------------
-- Same-school integrity guards (defense in depth beyond RLS):
-- a class, subject and staff member referenced together must all
-- belong to the row's school_id.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_check_class_teacher_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.classes c
                 WHERE c.id = NEW.class_id AND c.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'class does not belong to this school';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff s
                 WHERE s.id = NEW.staff_id AND s.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'staff member does not belong to this school';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_class_teacher_school ON public.class_teachers;
CREATE TRIGGER trg_check_class_teacher_school
  BEFORE INSERT OR UPDATE ON public.class_teachers
  FOR EACH ROW EXECUTE FUNCTION public.tg_check_class_teacher_school();

CREATE OR REPLACE FUNCTION public.tg_check_subject_assignment_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.classes c
                 WHERE c.id = NEW.class_id AND c.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'class does not belong to this school';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff s
                 WHERE s.id = NEW.staff_id AND s.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'staff member does not belong to this school';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.subjects sub
                 WHERE sub.id = NEW.subject_id AND sub.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'subject does not belong to this school';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_subject_assignment_school ON public.subject_assignments;
CREATE TRIGGER trg_check_subject_assignment_school
  BEFORE INSERT OR UPDATE ON public.subject_assignments
  FOR EACH ROW EXECUTE FUNCTION public.tg_check_subject_assignment_school();


-- ============================================================
-- SECTION 6: HELPER FUNCTIONS
-- ============================================================

-- Caller's staff.id (NULL if the profile has no staff record,
-- e.g. the original school owner or a guard created pre-chat17)
CREATE OR REPLACE FUNCTION public.get_my_staff_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT id FROM public.staff WHERE profile_id = auth.uid() LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_my_staff_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_staff_id() TO authenticated;

-- Caller's role (convenience for policies and RPCs)
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_my_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;

-- Permission check: school override first, then global default,
-- else false. Used by UI gating today; new policies can adopt it
-- when custom roles arrive.
CREATE OR REPLACE FUNCTION public.has_permission(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_result boolean;
BEGIN
  SELECT role, school_id INTO v_role, v_school
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF v_role IN ('school_admin', 'super_admin') THEN
    RETURN true;
  END IF;

  SELECT allowed INTO v_result
  FROM public.role_permissions
  WHERE school_id = v_school AND role = v_role AND permission_key = p_key;

  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;

  SELECT allowed INTO v_result
  FROM public.role_permissions
  WHERE school_id IS NULL AND role = v_role AND permission_key = p_key;

  RETURN COALESCE(v_result, false);
END;
$$;

REVOKE ALL ON FUNCTION public.has_permission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;


-- ============================================================
-- SECTION 7: ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.staff               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subjects            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_teachers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subject_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_attendance    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions    ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- staff: admin/principal manage; every staff member reads own
-- row. Colleague listings go through get_staff_directory_basic()
-- so DOB / mobile / address / documents stay private.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "staff_admin_principal_all" ON public.staff;
CREATE POLICY "staff_admin_principal_all"
  ON public.staff FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "staff_read_own_record" ON public.staff;
CREATE POLICY "staff_read_own_record"
  ON public.staff FOR SELECT
  USING ( profile_id = auth.uid() );

-- ------------------------------------------------------------
-- subjects: whole school reads (teachers need names); admin and
-- principal write.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "subjects_school_read" ON public.subjects;
CREATE POLICY "subjects_school_read"
  ON public.subjects FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "subjects_admin_principal_write" ON public.subjects;
CREATE POLICY "subjects_admin_principal_write"
  ON public.subjects FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

-- ------------------------------------------------------------
-- class_teachers / subject_assignments: whole school reads
-- (assignment names are not sensitive; needed by teacher pages
-- and class pages); admin and principal write.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "class_teachers_school_read" ON public.class_teachers;
CREATE POLICY "class_teachers_school_read"
  ON public.class_teachers FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "class_teachers_admin_principal_write" ON public.class_teachers;
CREATE POLICY "class_teachers_admin_principal_write"
  ON public.class_teachers FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "subject_assignments_school_read" ON public.subject_assignments;
CREATE POLICY "subject_assignments_school_read"
  ON public.subject_assignments FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "subject_assignments_admin_principal_write" ON public.subject_assignments;
CREATE POLICY "subject_assignments_admin_principal_write"
  ON public.subject_assignments FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

-- ------------------------------------------------------------
-- staff_attendance: admin/principal read + write; staff read own.
-- QR inserts go through record_staff_scan() (SECURITY DEFINER) so
-- guards need no direct policy here.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "staff_att_admin_principal_all" ON public.staff_attendance;
CREATE POLICY "staff_att_admin_principal_all"
  ON public.staff_attendance FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "staff_att_read_own" ON public.staff_attendance;
CREATE POLICY "staff_att_read_own"
  ON public.staff_attendance FOR SELECT
  USING ( staff_id = public.get_my_staff_id() );

-- ------------------------------------------------------------
-- leave_requests: reads only. ALL writes go through the RPCs
-- (apply_leave / cancel_leave / review_leave_request) which are
-- SECURITY DEFINER with their own validation. No write policies
-- on purpose.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "leave_req_admin_principal_read" ON public.leave_requests;
CREATE POLICY "leave_req_admin_principal_read"
  ON public.leave_requests FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "leave_req_read_own" ON public.leave_requests;
CREATE POLICY "leave_req_read_own"
  ON public.leave_requests FOR SELECT
  USING ( staff_id = public.get_my_staff_id() );

-- ------------------------------------------------------------
-- staff_documents: admin/principal manage; staff read own rows.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "staff_docs_admin_principal_all" ON public.staff_documents;
CREATE POLICY "staff_docs_admin_principal_all"
  ON public.staff_documents FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "staff_docs_read_own" ON public.staff_documents;
CREATE POLICY "staff_docs_read_own"
  ON public.staff_documents FOR SELECT
  USING ( staff_id = public.get_my_staff_id() );

-- ------------------------------------------------------------
-- login_history: admin reads school history; users read own.
-- Inserts happen inside touch_login() (SECURITY DEFINER).
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "login_history_admin_read" ON public.login_history;
CREATE POLICY "login_history_admin_read"
  ON public.login_history FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "login_history_read_own" ON public.login_history;
CREATE POLICY "login_history_read_own"
  ON public.login_history FOR SELECT
  USING ( profile_id = auth.uid() );

-- ------------------------------------------------------------
-- role_permissions: everyone reads globals + own school rows
-- (needed for UI gating); only school_admin writes own school
-- overrides. Global rows (school_id NULL) are seed-managed.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "role_permissions_read" ON public.role_permissions;
CREATE POLICY "role_permissions_read"
  ON public.role_permissions FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND (school_id IS NULL OR school_id = public.get_my_school_id())
  );

DROP POLICY IF EXISTS "role_permissions_admin_write" ON public.role_permissions;
CREATE POLICY "role_permissions_admin_write"
  ON public.role_permissions FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() = 'school_admin'
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() = 'school_admin'
  );


-- ============================================================
-- SECTION 8: STORAGE - private staff-docs bucket
-- Path convention: {school_id}/{staff_id}/{filename}
-- ============================================================

-- Upload limits (originally chat17b) are set here directly:
-- 500 KB per file + PDF/JPG/PNG/WebP only, ENFORCED BY THE BUCKET
-- (server-side, regardless of client). Keep in sync with the UI
-- constant MAX_UPLOAD_KB in app/lib/uploadLimits.ts.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'staff-docs', 'staff-docs', false,
  512000,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO UPDATE
SET file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Admin / principal: full access to their school's folder
DROP POLICY IF EXISTS "staff_docs_admin_manage" ON storage.objects;
CREATE POLICY "staff_docs_admin_manage" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'staff-docs'
    AND (storage.foldername(name))[1] = public.get_my_school_id()::text
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    bucket_id = 'staff-docs'
    AND (storage.foldername(name))[1] = public.get_my_school_id()::text
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

-- Staff member: read own folder (own documents + own leave docs)
DROP POLICY IF EXISTS "staff_docs_self_read" ON storage.objects;
CREATE POLICY "staff_docs_self_read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'staff-docs'
    AND (storage.foldername(name))[1] = public.get_my_school_id()::text
    AND (storage.foldername(name))[2] = public.get_my_staff_id()::text
  );

-- Staff member: upload into own folder only (leave documents)
DROP POLICY IF EXISTS "staff_docs_self_upload" ON storage.objects;
CREATE POLICY "staff_docs_self_upload" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'staff-docs'
    AND (storage.foldername(name))[1] = public.get_my_school_id()::text
    AND (storage.foldername(name))[2] = public.get_my_staff_id()::text
  );


-- ============================================================
-- SECTION 9: RPC FUNCTIONS
-- ============================================================

-- ------------------------------------------------------------
-- create_staff_member - SERVICE ROLE ONLY.
-- Called by the Node route /api/staff/create AFTER it has:
--   1. verified the caller is an active school_admin/principal
--   2. created the auth user (handle_new_user made the profile)
-- Claims the fresh profile, assigns EMP-NNNN atomically, inserts
-- the staff row. Everything in one transaction.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_staff_member(
  p_profile_id       uuid,
  p_school_id        uuid,
  p_role             text,
  p_full_name        text,
  p_mobile           text,
  p_email            text,
  p_designation      text,
  p_department       text    DEFAULT 'Teaching',
  p_is_teaching      boolean DEFAULT false,
  p_father_name      text    DEFAULT NULL,
  p_address          text    DEFAULT NULL,
  p_date_of_birth    date    DEFAULT NULL,
  p_gender           text    DEFAULT NULL,
  p_blood_group      text    DEFAULT NULL,
  p_qualification    text    DEFAULT NULL,
  p_experience_years numeric DEFAULT 0,
  p_joining_date     date    DEFAULT current_date,
  p_photo_url        text    DEFAULT NULL,
  p_created_by       uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_school uuid;
  v_seq            integer;
  v_employee_id    text;
  v_staff_id       uuid;
BEGIN
  -- role whitelist for this creation path
  IF p_role NOT IN ('principal', 'teacher', 'collector', 'receptionist', 'staff') THEN
    RAISE EXCEPTION 'invalid staff role: %', p_role;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = p_school_id AND is_active = true) THEN
    RAISE EXCEPTION 'school not found or inactive';
  END IF;

  -- the profile must exist (auth trigger) and be unclaimed or
  -- already belong to this school - prevents cross-school hijack
  SELECT school_id INTO v_profile_school
  FROM public.profiles WHERE id = p_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for new user';
  END IF;

  IF v_profile_school IS NOT NULL AND v_profile_school <> p_school_id THEN
    RAISE EXCEPTION 'profile already belongs to another school';
  END IF;

  IF EXISTS (SELECT 1 FROM public.staff WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'a staff record already exists for this user';
  END IF;

  IF p_full_name IS NULL OR length(trim(p_full_name)) = 0 THEN
    RAISE EXCEPTION 'full name is required';
  END IF;
  IF p_mobile IS NULL OR length(trim(p_mobile)) = 0 THEN
    RAISE EXCEPTION 'mobile is required';
  END IF;
  IF p_designation IS NULL OR length(trim(p_designation)) = 0 THEN
    RAISE EXCEPTION 'designation is required';
  END IF;

  -- atomic per-school employee number (row lock on schools)
  UPDATE public.schools
  SET    staff_id_seq = staff_id_seq + 1
  WHERE  id = p_school_id
  RETURNING staff_id_seq INTO v_seq;

  -- lpad grows past 4 digits instead of truncating
  v_employee_id := 'EMP-' || lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');

  UPDATE public.profiles
  SET school_id = p_school_id,
      role      = p_role,
      full_name = trim(p_full_name),
      phone     = trim(p_mobile),
      is_active = true
  WHERE id = p_profile_id;

  INSERT INTO public.staff (
    school_id, profile_id, employee_id, full_name, father_name,
    mobile, email, address, date_of_birth, gender, blood_group,
    qualification, experience_years, joining_date, department,
    designation, is_teaching, photo_url, created_by
  ) VALUES (
    p_school_id, p_profile_id, v_employee_id, trim(p_full_name), NULLIF(trim(COALESCE(p_father_name,'')),''),
    trim(p_mobile), lower(trim(p_email)), p_address, p_date_of_birth,
    NULLIF(trim(COALESCE(p_gender,'')),''), NULLIF(trim(COALESCE(p_blood_group,'')),''),
    p_qualification, COALESCE(p_experience_years, 0), COALESCE(p_joining_date, current_date),
    COALESCE(NULLIF(trim(p_department), ''), 'Teaching'),
    trim(p_designation), COALESCE(p_is_teaching, false), p_photo_url, p_created_by
  )
  RETURNING id INTO v_staff_id;

  RETURN jsonb_build_object(
    'staff_id',    v_staff_id,
    'employee_id', v_employee_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_staff_member(uuid,uuid,text,text,text,text,text,text,boolean,text,text,date,text,text,text,numeric,date,text,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_staff_member(uuid,uuid,text,text,text,text,text,text,boolean,text,text,date,text,text,text,numeric,date,text,uuid) TO service_role;

-- ------------------------------------------------------------
-- set_staff_status - admin/principal changes employment status
-- and login access together. SECURITY DEFINER because profiles
-- RLS does not let admins update other users' profile rows.
-- Terminal statuses force the login off.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_staff_status(
  p_staff_id     uuid,
  p_status       text,
  p_login_active boolean DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_profile_id    uuid;
  v_school        uuid;
  v_active        boolean;
BEGIN
  SELECT school_id, role INTO v_caller_school, v_caller_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('school_admin', 'principal') THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  IF p_status NOT IN ('active','probation','on_leave','resigned','terminated','retired') THEN
    RAISE EXCEPTION 'invalid employment status: %', p_status;
  END IF;

  SELECT profile_id, school_id INTO v_profile_id, v_school
  FROM public.staff WHERE id = p_staff_id;

  IF NOT FOUND OR v_school <> v_caller_school THEN
    RAISE EXCEPTION 'staff member not found';
  END IF;

  -- principals cannot deactivate the school admin's own record
  IF v_profile_id = auth.uid() AND p_status IN ('resigned','terminated','retired') THEN
    RAISE EXCEPTION 'you cannot set a terminal status on your own record';
  END IF;

  UPDATE public.staff
  SET employment_status = p_status
  WHERE id = p_staff_id;

  v_active := COALESCE(p_login_active, p_status NOT IN ('resigned','terminated','retired'));
  IF p_status IN ('resigned','terminated','retired') THEN
    v_active := false;
  END IF;

  UPDATE public.profiles
  SET is_active = v_active
  WHERE id = v_profile_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_staff_status(uuid,text,boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_staff_status(uuid,text,boolean) TO authenticated;

-- ------------------------------------------------------------
-- get_staff_directory_basic - safe colleague listing for any
-- active school member. Exposes NON-sensitive columns only.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_staff_directory_basic()
RETURNS TABLE (
  id           uuid,
  employee_id  text,
  full_name    text,
  designation  text,
  department   text,
  is_teaching  boolean,
  photo_url    text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT p.school_id INTO v_school
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.is_active = true;

  IF v_school IS NULL THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  RETURN QUERY
  SELECT s.id, s.employee_id, s.full_name, s.designation,
         s.department, s.is_teaching, s.photo_url
  FROM   public.staff s
  WHERE  s.school_id = v_school
    AND  s.employment_status IN ('active','probation','on_leave')
  ORDER BY s.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_staff_directory_basic() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_staff_directory_basic() TO authenticated;

-- ------------------------------------------------------------
-- mark_staff_attendance_bulk - admin/principal manual marking.
-- p_rows: [{"staff_id":"...","status":"present","check_in_time":"09:00",
--           "check_out_time":null,"remarks":null}, ...]
-- Upserts; source becomes 'manual'; returns rows written.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_staff_attendance_bulk(
  p_date date,
  p_rows jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_row           jsonb;
  v_staff_id      uuid;
  v_status        text;
  v_count         integer := 0;
BEGIN
  SELECT school_id, role INTO v_caller_school, v_caller_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('school_admin', 'principal') THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  IF p_date IS NULL OR p_date > current_date THEN
    RAISE EXCEPTION 'cannot mark attendance for a future date';
  END IF;
  IF p_date < current_date - 31 THEN
    RAISE EXCEPTION 'cannot mark attendance more than 31 days back';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'no rows supplied';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_staff_id := (v_row->>'staff_id')::uuid;
    v_status   := v_row->>'status';

    IF v_status NOT IN ('present','absent','late','half_day','leave') THEN
      RAISE EXCEPTION 'invalid status % for staff %', v_status, v_staff_id;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.staff s
                   WHERE s.id = v_staff_id AND s.school_id = v_caller_school) THEN
      RAISE EXCEPTION 'staff member % not found in this school', v_staff_id;
    END IF;

    INSERT INTO public.staff_attendance (
      school_id, staff_id, attendance_date, status,
      check_in_time, check_out_time, source, remarks, marked_by
    ) VALUES (
      v_caller_school, v_staff_id, p_date, v_status,
      NULLIF(v_row->>'check_in_time','')::time,
      NULLIF(v_row->>'check_out_time','')::time,
      'manual',
      NULLIF(v_row->>'remarks',''),
      auth.uid()
    )
    ON CONFLICT (school_id, staff_id, attendance_date)
    DO UPDATE SET
      status         = EXCLUDED.status,
      check_in_time  = COALESCE(EXCLUDED.check_in_time,  public.staff_attendance.check_in_time),
      check_out_time = COALESCE(EXCLUDED.check_out_time, public.staff_attendance.check_out_time),
      source         = 'manual',
      remarks        = EXCLUDED.remarks,
      marked_by      = auth.uid(),
      updated_at     = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_staff_attendance_bulk(date,jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.mark_staff_attendance_bulk(date,jsonb) TO authenticated;

-- ------------------------------------------------------------
-- record_staff_scan - QR flow. Called from the scan page when a
-- STAFF: QR is read. Caller must be an active guard / admin /
-- principal of the SAME school. First scan of the day = check-in
-- (late if after schools.staff_late_after_time); later scans set
-- or extend check-out. Returns jsonb, never raises for normal
-- flow problems, so the scan UI can show a friendly message.
-- Times are Asia/Kolkata (India-only product).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_staff_scan(p_staff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_staff         record;
  v_late_after    time;
  v_today         date;
  v_now_time      time;
  v_existing      record;
  v_status        text;
BEGIN
  SELECT school_id, role INTO v_caller_school, v_caller_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('guard', 'school_admin', 'principal') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Not authorised to scan');
  END IF;

  SELECT s.id, s.school_id, s.full_name, s.employment_status
  INTO v_staff
  FROM public.staff s
  WHERE s.id = p_staff_id;

  -- generic message on cross-school or unknown: no information leak
  IF NOT FOUND OR v_staff.school_id <> v_caller_school THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Staff member not found');
  END IF;

  IF v_staff.employment_status NOT IN ('active', 'probation') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Staff member is not active');
  END IF;

  SELECT staff_late_after_time INTO v_late_after
  FROM public.schools WHERE id = v_caller_school;

  v_today    := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_now_time := (now() AT TIME ZONE 'Asia/Kolkata')::time;

  -- approved leave covering today blocks the scan
  IF EXISTS (SELECT 1 FROM public.leave_requests lr
             WHERE lr.staff_id = p_staff_id
               AND lr.status = 'approved'
               AND v_today BETWEEN lr.from_date AND lr.to_date) THEN
    RETURN jsonb_build_object('ok', false,
      'message', v_staff.full_name || ' is on approved leave today');
  END IF;

  SELECT * INTO v_existing
  FROM public.staff_attendance
  WHERE school_id = v_caller_school
    AND staff_id  = p_staff_id
    AND attendance_date = v_today;

  IF NOT FOUND THEN
    -- first scan of the day: check-in
    v_status := CASE WHEN v_now_time > COALESCE(v_late_after, '09:15'::time)
                     THEN 'late' ELSE 'present' END;

    INSERT INTO public.staff_attendance (
      school_id, staff_id, attendance_date, status,
      check_in_time, source, marked_by
    ) VALUES (
      v_caller_school, p_staff_id, v_today, v_status,
      v_now_time, 'qr', auth.uid()
    );

    RETURN jsonb_build_object(
      'ok', true, 'action', 'checked_in', 'status', v_status,
      'staff_name', v_staff.full_name,
      'time', to_char(v_now_time, 'HH24:MI')
    );
  END IF;

  IF v_existing.status = 'leave' THEN
    RETURN jsonb_build_object('ok', false,
      'message', v_staff.full_name || ' is marked on leave today');
  END IF;

  -- row exists but no check-in (manually marked earlier): set it
  IF v_existing.check_in_time IS NULL THEN
    UPDATE public.staff_attendance
    SET check_in_time = v_now_time, source = 'qr', updated_at = now()
    WHERE id = v_existing.id;

    RETURN jsonb_build_object(
      'ok', true, 'action', 'checked_in', 'status', v_existing.status,
      'staff_name', v_staff.full_name,
      'time', to_char(v_now_time, 'HH24:MI')
    );
  END IF;

  -- double-tap debounce: ignore a second scan within 2 minutes
  IF v_existing.check_out_time IS NULL
     AND v_now_time <= v_existing.check_in_time + interval '2 minutes' THEN
    RETURN jsonb_build_object(
      'ok', true, 'action', 'duplicate', 'status', v_existing.status,
      'staff_name', v_staff.full_name,
      'time', to_char(v_existing.check_in_time, 'HH24:MI')
    );
  END IF;

  -- check-out (or extend an existing check-out to the latest scan)
  UPDATE public.staff_attendance
  SET check_out_time = v_now_time, updated_at = now()
  WHERE id = v_existing.id;

  RETURN jsonb_build_object(
    'ok', true, 'action', 'checked_out', 'status', v_existing.status,
    'staff_name', v_staff.full_name,
    'time', to_char(v_now_time, 'HH24:MI')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_staff_scan(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_staff_scan(uuid) TO authenticated;

-- ------------------------------------------------------------
-- apply_leave - staff member applies for own leave
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_leave(
  p_leave_type    text,
  p_from_date     date,
  p_to_date       date,
  p_reason        text,
  p_document_path text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff_id uuid;
  v_school   uuid;
  v_leave_id uuid;
BEGIN
  SELECT s.id, s.school_id INTO v_staff_id, v_school
  FROM public.staff s
  JOIN public.profiles p ON p.id = s.profile_id AND p.is_active = true
  WHERE s.profile_id = auth.uid()
    AND s.employment_status IN ('active','probation','on_leave');

  IF v_staff_id IS NULL THEN
    RAISE EXCEPTION 'no active staff record for this account';
  END IF;

  IF p_leave_type NOT IN ('casual','sick','earned','unpaid','other') THEN
    RAISE EXCEPTION 'invalid leave type';
  END IF;
  IF p_from_date IS NULL OR p_to_date IS NULL OR p_to_date < p_from_date THEN
    RAISE EXCEPTION 'invalid date range';
  END IF;
  IF p_from_date < current_date - 7 THEN
    RAISE EXCEPTION 'leave cannot start more than 7 days in the past';
  END IF;
  IF (p_to_date - p_from_date) + 1 > 90 THEN
    RAISE EXCEPTION 'leave cannot exceed 90 days';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'reason is required';
  END IF;

  IF EXISTS (SELECT 1 FROM public.leave_requests lr
             WHERE lr.staff_id = v_staff_id
               AND lr.status IN ('pending','approved')
               AND lr.from_date <= p_to_date
               AND lr.to_date   >= p_from_date) THEN
    RAISE EXCEPTION 'an overlapping leave request already exists';
  END IF;

  INSERT INTO public.leave_requests (
    school_id, staff_id, leave_type, from_date, to_date,
    reason, document_path
  ) VALUES (
    v_school, v_staff_id, p_leave_type, p_from_date, p_to_date,
    trim(p_reason), p_document_path
  )
  RETURNING id INTO v_leave_id;

  RETURN v_leave_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_leave(text,date,date,text,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.apply_leave(text,date,date,text,text) TO authenticated;

-- ------------------------------------------------------------
-- cancel_leave - owner cancels own PENDING request
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_leave(p_leave_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff_id uuid;
BEGIN
  v_staff_id := public.get_my_staff_id();
  IF v_staff_id IS NULL THEN
    RAISE EXCEPTION 'no staff record for this account';
  END IF;

  UPDATE public.leave_requests
  SET status = 'cancelled'
  WHERE id = p_leave_id
    AND staff_id = v_staff_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'leave request not found or no longer pending';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_leave(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cancel_leave(uuid) TO authenticated;

-- ------------------------------------------------------------
-- review_leave_request - admin/principal approves or rejects.
-- On approval, staff_attendance rows are synced as 'leave' for
-- the range, but a day already marked present/late/half_day by a
-- human or a scan is NEVER downgraded (only missing rows and
-- 'absent' rows become leave).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_leave_request(
  p_leave_id uuid,
  p_action   text,
  p_comment  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_leave         record;
  v_synced        integer := 0;
BEGIN
  SELECT school_id, role INTO v_caller_school, v_caller_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('school_admin', 'principal') THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  IF p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'action must be approve or reject';
  END IF;

  SELECT * INTO v_leave
  FROM public.leave_requests
  WHERE id = p_leave_id AND school_id = v_caller_school
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'leave request not found';
  END IF;
  IF v_leave.status <> 'pending' THEN
    RAISE EXCEPTION 'leave request is already %', v_leave.status;
  END IF;

  -- principals cannot approve their own leave
  IF EXISTS (SELECT 1 FROM public.staff s
             WHERE s.id = v_leave.staff_id AND s.profile_id = auth.uid()) THEN
    RAISE EXCEPTION 'you cannot review your own leave request';
  END IF;

  UPDATE public.leave_requests
  SET status        = CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END,
      admin_comment = NULLIF(trim(COALESCE(p_comment, '')), ''),
      reviewed_by   = auth.uid(),
      reviewed_at   = now()
  WHERE id = p_leave_id;

  IF p_action = 'approve' THEN
    INSERT INTO public.staff_attendance (
      school_id, staff_id, attendance_date, status, source, marked_by, remarks
    )
    SELECT v_leave.school_id, v_leave.staff_id, d::date, 'leave', 'leave_sync',
           auth.uid(), 'Approved leave'
    FROM   generate_series(v_leave.from_date, v_leave.to_date, interval '1 day') d
    ON CONFLICT (school_id, staff_id, attendance_date)
    DO UPDATE SET
      status     = 'leave',
      source     = 'leave_sync',
      marked_by  = auth.uid(),
      remarks    = 'Approved leave',
      updated_at = now()
    WHERE public.staff_attendance.status = 'absent';

    GET DIAGNOSTICS v_synced = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'status', CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END,
    'attendance_rows_synced', v_synced
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_leave_request(uuid,text,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.review_leave_request(uuid,text,text) TO authenticated;

-- ------------------------------------------------------------
-- get_teacher_assignments - a teacher's classes + subjects.
-- Self always allowed; admin/principal may query anyone in the
-- same school (used on the staff detail page).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_teacher_assignments(
  p_staff_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_target        uuid;
  v_target_school uuid;
  v_classes       jsonb;
  v_subjects      jsonb;
BEGIN
  SELECT school_id, role INTO v_caller_school, v_caller_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_caller_school IS NULL THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  v_target := COALESCE(p_staff_id, public.get_my_staff_id());
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'no staff record';
  END IF;

  SELECT school_id INTO v_target_school FROM public.staff WHERE id = v_target;
  IF v_target_school IS NULL OR v_target_school <> v_caller_school THEN
    RAISE EXCEPTION 'staff member not found';
  END IF;

  IF v_target <> COALESCE(public.get_my_staff_id(), '00000000-0000-0000-0000-000000000000'::uuid)
     AND v_caller_role NOT IN ('school_admin', 'principal') THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'class_id', c.id, 'name', c.name, 'section', c.section
         ) ORDER BY c.name, c.section), '[]'::jsonb)
  INTO v_classes
  FROM public.class_teachers ct
  JOIN public.classes c ON c.id = ct.class_id
  WHERE ct.staff_id = v_target;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'assignment_id', sa.id,
           'subject_id', sub.id, 'subject', sub.name,
           'class_id', c.id, 'class_name', c.name, 'section', c.section
         ) ORDER BY sub.name, c.name, c.section), '[]'::jsonb)
  INTO v_subjects
  FROM public.subject_assignments sa
  JOIN public.subjects sub ON sub.id = sa.subject_id
  JOIN public.classes  c   ON c.id  = sa.class_id
  WHERE sa.staff_id = v_target;

  RETURN jsonb_build_object(
    'class_teacher_of', v_classes,
    'subjects',         v_subjects
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_teacher_assignments(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_teacher_assignments(uuid) TO authenticated;

-- ------------------------------------------------------------
-- get_staff_attendance_summary - monthly report.
-- Admin/principal: whole school. Anyone else: own row only.
-- working_days = distinct dates with ANY attendance marked for
-- the school that month (until a school-calendar module exists).
-- percentage counts present + late as 1, half_day as 0.5.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_staff_attendance_summary(p_month text)
RETURNS TABLE (
  staff_id      uuid,
  employee_id   text,
  full_name     text,
  department    text,
  designation   text,
  present_days  integer,
  late_days     integer,
  half_days     integer,
  absent_days   integer,
  leave_days    integer,
  working_days  integer,
  percentage    numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_my_staff      uuid;
  v_start         date;
  v_end           date;
  v_working       integer;
BEGIN
  SELECT p.school_id, p.role INTO v_caller_school, v_caller_role
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.is_active = true;

  IF v_caller_school IS NULL THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  BEGIN
    v_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'month must be YYYY-MM';
  END;
  v_end := (v_start + interval '1 month' - interval '1 day')::date;

  v_my_staff := public.get_my_staff_id();

  SELECT COUNT(DISTINCT sa.attendance_date) INTO v_working
  FROM public.staff_attendance sa
  WHERE sa.school_id = v_caller_school
    AND sa.attendance_date BETWEEN v_start AND v_end;

  RETURN QUERY
  SELECT
    s.id,
    s.employee_id,
    s.full_name,
    s.department,
    s.designation,
    COUNT(*) FILTER (WHERE sa.status = 'present')::integer,
    COUNT(*) FILTER (WHERE sa.status = 'late')::integer,
    COUNT(*) FILTER (WHERE sa.status = 'half_day')::integer,
    COUNT(*) FILTER (WHERE sa.status = 'absent')::integer,
    COUNT(*) FILTER (WHERE sa.status = 'leave')::integer,
    v_working,
    CASE WHEN v_working = 0 THEN 0
         ELSE round(
           (COUNT(*) FILTER (WHERE sa.status IN ('present','late'))
            + COUNT(*) FILTER (WHERE sa.status = 'half_day') * 0.5
           )::numeric * 100 / v_working, 1)
    END
  FROM public.staff s
  LEFT JOIN public.staff_attendance sa
    ON  sa.staff_id = s.id
    AND sa.attendance_date BETWEEN v_start AND v_end
  WHERE s.school_id = v_caller_school
    AND s.employment_status IN ('active','probation','on_leave')
    AND (v_caller_role IN ('school_admin','principal') OR s.id = v_my_staff)
  GROUP BY s.id, s.employee_id, s.full_name, s.department, s.designation
  ORDER BY s.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_staff_attendance_summary(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_staff_attendance_summary(text) TO authenticated;

-- ------------------------------------------------------------
-- get_staff_dashboard_stats - principal dashboard cards.
-- One call: totals, today's attendance breakdown, leave stats.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_staff_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_today         date;
  v_total         integer;
  v_teaching      integer;
  v_present       integer;
  v_late          integer;
  v_half          integer;
  v_absent        integer;
  v_on_leave      integer;
  v_pending       integer;
BEGIN
  SELECT school_id, role INTO v_caller_school, v_caller_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('school_admin', 'principal') THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  v_today := (now() AT TIME ZONE 'Asia/Kolkata')::date;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE is_teaching)::integer
  INTO v_total, v_teaching
  FROM public.staff
  WHERE school_id = v_caller_school
    AND employment_status IN ('active','probation','on_leave');

  SELECT
    COUNT(*) FILTER (WHERE status = 'present')::integer,
    COUNT(*) FILTER (WHERE status = 'late')::integer,
    COUNT(*) FILTER (WHERE status = 'half_day')::integer,
    COUNT(*) FILTER (WHERE status = 'absent')::integer,
    COUNT(*) FILTER (WHERE status = 'leave')::integer
  INTO v_present, v_late, v_half, v_absent, v_on_leave
  FROM public.staff_attendance
  WHERE school_id = v_caller_school
    AND attendance_date = v_today;

  SELECT COUNT(*)::integer INTO v_pending
  FROM public.leave_requests
  WHERE school_id = v_caller_school AND status = 'pending';

  RETURN jsonb_build_object(
    'total_staff',        v_total,
    'teaching_staff',     v_teaching,
    'non_teaching_staff', v_total - v_teaching,
    'today', jsonb_build_object(
      'present',  COALESCE(v_present, 0),
      'late',     COALESCE(v_late, 0),
      'half_day', COALESCE(v_half, 0),
      'absent',   COALESCE(v_absent, 0),
      'on_leave', COALESCE(v_on_leave, 0),
      'unmarked', greatest(v_total
                    - COALESCE(v_present,0) - COALESCE(v_late,0)
                    - COALESCE(v_half,0) - COALESCE(v_absent,0)
                    - COALESCE(v_on_leave,0), 0)
    ),
    'pending_leave_requests', COALESCE(v_pending, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_staff_dashboard_stats() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_staff_dashboard_stats() TO authenticated;

-- ------------------------------------------------------------
-- touch_login - called by the login flow after a successful
-- sign-in. Updates last_login_at and writes a history row.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_login(p_user_agent text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_school uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.profiles
  SET last_login_at = now()
  WHERE id = auth.uid()
  RETURNING school_id INTO v_school;

  INSERT INTO public.login_history (school_id, profile_id, user_agent)
  VALUES (v_school, auth.uid(), left(p_user_agent, 300));
END;
$$;

REVOKE ALL ON FUNCTION public.touch_login(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.touch_login(text) TO authenticated;


-- ============================================================
-- SECTION 10: role_permissions - GLOBAL DEFAULT SEEDS
-- school_admin and super_admin short-circuit to true inside
-- has_permission(), so they need no rows here.
-- ============================================================

INSERT INTO public.role_permissions (school_id, role, permission_key, allowed)
VALUES
  -- principal: full academic access, staff management, no fee mutation
  (NULL, 'principal',    'staff.view',            true),
  (NULL, 'principal',    'staff.manage',          true),
  (NULL, 'principal',    'staff.attendance.mark', true),
  (NULL, 'principal',    'leave.apply',           true),
  (NULL, 'principal',    'leave.review',          true),
  (NULL, 'principal',    'students.view',         true),
  (NULL, 'principal',    'students.manage',       true),
  (NULL, 'principal',    'classes.view',          true),
  (NULL, 'principal',    'classes.manage',        true),
  (NULL, 'principal',    'subjects.manage',       true),
  (NULL, 'principal',    'assignments.manage',    true),
  (NULL, 'principal',    'attendance.view',       true),
  (NULL, 'principal',    'reports.staff',         true),
  (NULL, 'principal',    'fees.view',             true),
  (NULL, 'principal',    'dashboard.principal',   true),

  -- teacher: own classes and subjects, self-service
  (NULL, 'teacher',      'dashboard.teacher',     true),
  (NULL, 'teacher',      'students.view',         true),
  (NULL, 'teacher',      'classes.view',          true),
  (NULL, 'teacher',      'attendance.view',       true),
  (NULL, 'teacher',      'leave.apply',           true),

  -- collector (accountant): fee module only, self-service
  (NULL, 'collector',    'fees.view',             true),
  (NULL, 'collector',    'fees.collect',          true),
  (NULL, 'collector',    'leave.apply',           true),

  -- receptionist: admissions + student management, self-service
  (NULL, 'receptionist', 'students.view',         true),
  (NULL, 'receptionist', 'students.manage',       true),
  (NULL, 'receptionist', 'classes.view',          true),
  (NULL, 'receptionist', 'leave.apply',           true),

  -- generic staff (librarian, transport manager, etc): self-service
  (NULL, 'staff',        'leave.apply',           true)
ON CONFLICT DO NOTHING;


-- ============================================================
-- SECTION 11: pg_cron - purge login_history older than 180 days
-- 21:30 UTC = 03:00 IST (quiet hours)
-- ============================================================

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'purge-login-history';
EXCEPTION WHEN others THEN
  NULL;
END;
$$;

SELECT cron.schedule(
  'purge-login-history',
  '30 21 * * *',
  $$ DELETE FROM public.login_history WHERE logged_in_at < now() - interval '180 days' $$
);


-- ============================================================


-- ##################################################################
-- PART 2: TEACHER WORKSPACE (chat18)
-- Classroom roll-call attendance is a THIRD attendance table -
-- independent from gate scans (attendance) and staff_attendance.
-- ##################################################################

-- ============================================================
-- SECTION 1: class_attendance
-- One row per student per day. A student is in exactly one class,
-- so UNIQUE(student_id, attendance_date); class_id is recorded for
-- reporting and RLS scoping.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.class_attendance (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id        uuid        NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  class_id         uuid        NOT NULL REFERENCES public.classes(id)  ON DELETE CASCADE,
  student_id       uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  attendance_date  date        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('present','absent','late')),
  source           text        NOT NULL DEFAULT 'teacher' CHECK (source IN ('teacher','admin')),
  marked_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_class_attendance_day UNIQUE (student_id, attendance_date)
);

COMMENT ON TABLE public.class_attendance IS
  'Classroom roll call marked by the class teacher. The gate-scan '
  'table (attendance) records QR entry/exit; the marking UI shows '
  'gate scans as a hint but the two are independent records.';

CREATE INDEX IF NOT EXISTS idx_class_att_school_date ON public.class_attendance(school_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_class_att_class_date  ON public.class_attendance(class_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_class_att_student     ON public.class_attendance(student_id);

DROP TRIGGER IF EXISTS trg_class_att_updated_at ON public.class_attendance;
CREATE TRIGGER trg_class_att_updated_at
  BEFORE UPDATE ON public.class_attendance
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();


-- ============================================================
-- SECTION 2: HELPER - is the caller a class teacher of this class?
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_class_teacher_of(p_class_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.class_teachers ct
    JOIN public.staff s ON s.id = ct.staff_id
    WHERE ct.class_id = p_class_id
      AND s.profile_id = auth.uid()
      AND s.employment_status IN ('active','probation','on_leave')
  );
$$;

REVOKE ALL ON FUNCTION public.is_class_teacher_of(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_class_teacher_of(uuid) TO authenticated;


-- ============================================================
-- SECTION 3: RLS
-- ============================================================

ALTER TABLE public.class_attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "class_att_admin_principal_all" ON public.class_attendance;
CREATE POLICY "class_att_admin_principal_all"
  ON public.class_attendance FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "class_att_class_teacher_read" ON public.class_attendance;
CREATE POLICY "class_att_class_teacher_read"
  ON public.class_attendance FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.is_class_teacher_of(class_id)
  );

-- Teacher writes go exclusively through mark_class_attendance()
-- (SECURITY DEFINER) - no direct write policy on purpose.


-- ============================================================
-- SECTION 4: RPCs
-- ============================================================

-- ------------------------------------------------------------
-- mark_class_attendance - class teacher of the class, or admin/
-- principal. Date window: today back to 7 days (IST). p_rows:
-- [{"student_id":"...","status":"present"}, ...]
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_class_attendance(
  p_class_id uuid,
  p_date     date,
  p_rows     jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_class_school  uuid;
  v_today         date;
  v_source        text;
  v_row           jsonb;
  v_student_id    uuid;
  v_status        text;
  v_count         integer := 0;
BEGIN
  SELECT school_id, role INTO v_caller_school, v_caller_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  IF v_caller_role IN ('school_admin', 'principal') THEN
    v_source := 'admin';
  ELSIF v_caller_role = 'teacher' AND public.is_class_teacher_of(p_class_id) THEN
    v_source := 'teacher';
  ELSE
    RAISE EXCEPTION 'only the class teacher or an admin can mark this class';
  END IF;

  SELECT school_id INTO v_class_school FROM public.classes WHERE id = p_class_id;
  IF v_class_school IS NULL OR v_class_school <> v_caller_school THEN
    RAISE EXCEPTION 'class not found';
  END IF;

  v_today := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  IF p_date IS NULL OR p_date > v_today THEN
    RAISE EXCEPTION 'cannot mark attendance for a future date';
  END IF;
  IF p_date < v_today - 7 THEN
    RAISE EXCEPTION 'cannot mark attendance more than 7 days back';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'no rows supplied';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_student_id := (v_row->>'student_id')::uuid;
    v_status     := v_row->>'status';

    IF v_status NOT IN ('present','absent','late') THEN
      RAISE EXCEPTION 'invalid status % for student %', v_status, v_student_id;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.students st
                   WHERE st.id = v_student_id
                     AND st.class_id = p_class_id
                     AND st.school_id = v_caller_school
                     AND st.is_active = true) THEN
      RAISE EXCEPTION 'student % is not an active member of this class', v_student_id;
    END IF;

    INSERT INTO public.class_attendance (
      school_id, class_id, student_id, attendance_date,
      status, source, marked_by
    ) VALUES (
      v_caller_school, p_class_id, v_student_id, p_date,
      v_status, v_source, auth.uid()
    )
    ON CONFLICT (student_id, attendance_date)
    DO UPDATE SET
      status     = EXCLUDED.status,
      class_id   = EXCLUDED.class_id,
      source     = EXCLUDED.source,
      marked_by  = auth.uid(),
      updated_at = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_class_attendance(uuid,date,jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.mark_class_attendance(uuid,date,jsonb) TO authenticated;

-- ------------------------------------------------------------
-- get_class_fee_summary - READ-ONLY per-student dues for a class.
-- Callable by the CLASS TEACHER of that class (view + due list, no
-- collection) or admin/principal. Deliberately an RPC so teacher
-- access does not depend on the fee tables' RLS.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_class_fee_summary(p_class_id uuid)
RETURNS TABLE (
  student_id    uuid,
  full_name     text,
  total_due     numeric,
  total_paid    numeric,
  balance       numeric,
  overdue_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_caller_school uuid;
  v_caller_role   text;
  v_class_school  uuid;
BEGIN
  SELECT p.school_id, p.role INTO v_caller_school, v_caller_role
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.is_active = true;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'not authorised';
  END IF;

  IF v_caller_role NOT IN ('school_admin', 'principal')
     AND NOT (v_caller_role = 'teacher' AND public.is_class_teacher_of(p_class_id)) THEN
    RAISE EXCEPTION 'only the class teacher or an admin can view this';
  END IF;

  SELECT c.school_id INTO v_class_school FROM public.classes c WHERE c.id = p_class_id;
  IF v_class_school IS NULL OR v_class_school <> v_caller_school THEN
    RAISE EXCEPTION 'class not found';
  END IF;

  RETURN QUERY
  SELECT
    st.id,
    st.full_name,
    COALESCE(SUM(fd.total_due), 0)::numeric,
    COALESCE(SUM(fd.amount_paid), 0)::numeric,
    COALESCE(SUM(fd.balance), 0)::numeric,
    (COUNT(*) FILTER (WHERE fd.balance > 0 AND fd.due_date < current_date))::integer
  FROM public.students st
  LEFT JOIN public.fee_dues fd ON fd.student_id = st.id
  WHERE st.class_id = p_class_id
    AND st.school_id = v_caller_school
    AND st.is_active = true
  GROUP BY st.id, st.full_name
  ORDER BY st.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_class_fee_summary(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_class_fee_summary(uuid) TO authenticated;


-- ============================================================


-- ##################################################################
-- PART 3: SECURITY HARDENING (chat19)
-- Replaces chat02 blanket FOR ALL policies on students/classes and
-- the any-member schools UPDATE policy. Exploit-tested.
-- ##################################################################

-- ============================================================
-- SECTION 1: HELPER - does the caller teach this class?
-- (class teacher OR subject teacher; used for student read scope)
-- ============================================================

CREATE OR REPLACE FUNCTION public.teaches_in_class(p_class_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.class_teachers ct
    JOIN public.staff s ON s.id = ct.staff_id
    WHERE ct.class_id = p_class_id
      AND s.profile_id = auth.uid()
      AND s.employment_status IN ('active','probation','on_leave')
  )
  OR EXISTS (
    SELECT 1
    FROM public.subject_assignments sa
    JOIN public.staff s ON s.id = sa.staff_id
    WHERE sa.class_id = p_class_id
      AND s.profile_id = auth.uid()
      AND s.employment_status IN ('active','probation','on_leave')
  );
$$;

REVOKE ALL ON FUNCTION public.teaches_in_class(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.teaches_in_class(uuid) TO authenticated;


-- ============================================================
-- SECTION 2: STUDENTS - replace the blanket FOR ALL policy
-- ============================================================

DROP POLICY IF EXISTS "school_sees_own_students" ON public.students;

-- Read: office roles + guards see the whole school; teachers see
-- only students of classes they teach.
DROP POLICY IF EXISTS "students_school_read" ON public.students;
CREATE POLICY "students_school_read"
  ON public.students FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin','principal','receptionist','collector','guard')
      OR public.teaches_in_class(class_id)
    )
  );

-- Writes: student management roles only (per permission spec:
-- receptionist = admissions and student management).
DROP POLICY IF EXISTS "students_office_insert" ON public.students;
CREATE POLICY "students_office_insert"
  ON public.students FOR INSERT
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal','receptionist')
  );

DROP POLICY IF EXISTS "students_office_update" ON public.students;
CREATE POLICY "students_office_update"
  ON public.students FOR UPDATE
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal','receptionist')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal','receptionist')
  );

DROP POLICY IF EXISTS "students_office_delete" ON public.students;
CREATE POLICY "students_office_delete"
  ON public.students FOR DELETE
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal','receptionist')
  );


-- ============================================================
-- SECTION 3: CLASSES - reads stay school-wide, writes tightened
-- ============================================================

DROP POLICY IF EXISTS "school_sees_own_classes" ON public.classes;

DROP POLICY IF EXISTS "classes_school_read" ON public.classes;
CREATE POLICY "classes_school_read"
  ON public.classes FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "classes_admin_insert" ON public.classes;
CREATE POLICY "classes_admin_insert"
  ON public.classes FOR INSERT
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal')
  );

DROP POLICY IF EXISTS "classes_admin_update" ON public.classes;
CREATE POLICY "classes_admin_update"
  ON public.classes FOR UPDATE
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal')
  );

DROP POLICY IF EXISTS "classes_admin_delete" ON public.classes;
CREATE POLICY "classes_admin_delete"
  ON public.classes FOR DELETE
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin','principal')
  );


-- ============================================================
-- SECTION 4: SCHOOLS - close the chat16-deferred UPDATE hole
-- (any member could update the schools row, including override
-- PIN column and waiver caps)
-- ============================================================

DROP POLICY IF EXISTS "users_update_own_school" ON public.schools;

DROP POLICY IF EXISTS "schools_admin_update" ON public.schools;
CREATE POLICY "schools_admin_update"
  ON public.schools FOR UPDATE
  USING (
    id = public.get_my_school_id()
    AND public.get_my_role() = 'school_admin'
  )
  WITH CHECK (
    id = public.get_my_school_id()
    AND public.get_my_role() = 'school_admin'
  );


-- ============================================================


-- ##################################################################
-- PART 4: RELOAD POSTGREST SCHEMA CACHE
-- One reload for the whole migration.
-- ##################################################################

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF CONSOLIDATED CHAT 17 SESSION MIGRATION
-- ============================================================
