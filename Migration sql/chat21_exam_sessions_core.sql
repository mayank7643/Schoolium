-- ============================================================
-- SCHOOLIUM - CHAT 21 - EXAM MODULE PHASE 1
-- exam_sessions_core
-- Design: docs/exam-module/ (Steps 1-9). Assumes chat02..chat20.
-- ============================================================
-- Contents:
--   SECTION 1  Tables: academic_sessions, academic_terms,
--              exam_types, exam_rooms, exams, exam_classes,
--              exam_subjects, exam_enrollments,
--              student_subject_overrides, exam_audit_log
--   SECTION 2  Indexes
--   SECTION 3  Helper functions (ctx, teaches_subject_in_class,
--              get_current_session_id, exam_is_mutable, audit)
--   SECTION 4  Triggers (updated_at, same-school, session lock,
--              exam-state guards, exam date denormalization)
--   SECTION 5  RLS (reads via policies; ALL lifecycle writes are
--              RPC-only - deliberately stricter than doc Step 9 P1
--              for every state-bearing table)
--   SECTION 6  RPCs - sessions and terms
--   SECTION 7  RPCs - exam lifecycle and configuration
--   SECTION 8  RPCs - timetable validation v1, enrollments,
--              overrides
--   SECTION 9  Permission seeds
--   SECTION 10 pg_cron: auto status roll
--   SECTION 11 PostgREST schema reload
--
-- Notes:
--  * exam_rooms ships here (not chat22) because exam_subjects and
--    exam_enrollments carry room_id FKs.
--  * validate_exam_timetable is v1 (MISSING_SCHEDULE, CLASS_OVERLAP,
--    SAME_DAY_LOAD). chat22 extends it (holidays, room checks) via
--    CREATE OR REPLACE.
--  * unpublish_exam / cancel_exam gain extra side effects in later
--    migrations (admit card revocation chat22, marks checks chat23)
--    via CREATE OR REPLACE - same evolution pattern as the fee RPCs.
--  * Idempotent throughout. Pure ASCII.
-- ============================================================


-- ============================================================
-- SECTION 1: TABLES
-- ============================================================

-- ------------------------------------------------------------
-- academic_sessions - one row per academic year per school
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.academic_sessions (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  start_date  date        NOT NULL,
  end_date    date        NOT NULL,
  status      text        NOT NULL DEFAULT 'upcoming'
                          CHECK (status IN ('upcoming','active','locked','archived')),
  is_current  boolean     NOT NULL DEFAULT false,
  created_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_academic_sessions_name UNIQUE (school_id, name),
  CONSTRAINT ck_session_dates CHECK (end_date > start_date)
);

COMMENT ON TABLE public.academic_sessions IS
  'Academic year (e.g. 2026-27). status=locked blocks all exam-module '
  'writes in the session; archived = locked + hidden from pickers. '
  'Fee module academic_year TEXT columns are untouched (backward compat).';

-- one current session per school
CREATE UNIQUE INDEX IF NOT EXISTS uq_academic_sessions_current
  ON public.academic_sessions (school_id)
  WHERE is_current;

-- ------------------------------------------------------------
-- academic_terms - terms / semesters inside a session
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.academic_terms (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id         uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  session_id        uuid        NOT NULL REFERENCES public.academic_sessions(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  term_type         text        NOT NULL DEFAULT 'term'
                                CHECK (term_type IN ('term','semester')),
  sort_order        integer     NOT NULL DEFAULT 1,
  start_date        date        NOT NULL,
  end_date          date        NOT NULL,
  weightage_percent numeric(5,2) NOT NULL DEFAULT 100
                                CHECK (weightage_percent >= 0 AND weightage_percent <= 100),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_academic_terms_name UNIQUE (session_id, name),
  CONSTRAINT ck_term_dates CHECK (end_date >= start_date)
);

-- ------------------------------------------------------------
-- exam_types - per-school catalogue (seeded on session creation)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_types (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id         uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  code              text,
  category          text        NOT NULL DEFAULT 'custom'
                                CHECK (category IN ('unit_test','monthly','quarterly',
                                                    'half_yearly','annual','practical','custom')),
  default_weightage numeric(5,2) NOT NULL DEFAULT 100
                                CHECK (default_weightage >= 0 AND default_weightage <= 100),
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exam_types_name UNIQUE (school_id, name)
);

-- ------------------------------------------------------------
-- exam_rooms - physical rooms for exam seating / timetable
-- (lives here because exam_subjects/enrollments FK it)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_rooms (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  capacity    integer     CHECK (capacity IS NULL OR capacity > 0),
  location    text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exam_rooms_name UNIQUE (school_id, name)
);

-- ------------------------------------------------------------
-- exams - the exam event. State machine via RPCs only.
-- start_date/end_date are DENORMALIZED from exam_subjects by
-- trigger - never written by hand.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exams (
  id                   uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id            uuid        NOT NULL REFERENCES public.schools(id)            ON DELETE CASCADE,
  session_id           uuid        NOT NULL REFERENCES public.academic_sessions(id)  ON DELETE RESTRICT,
  term_id              uuid        REFERENCES public.academic_terms(id)              ON DELETE RESTRICT,
  exam_type_id         uuid        NOT NULL REFERENCES public.exam_types(id)         ON DELETE RESTRICT,
  name                 text        NOT NULL,
  status               text        NOT NULL DEFAULT 'draft'
                                   CHECK (status IN ('draft','published','ongoing',
                                                     'completed','locked','cancelled')),
  start_date           date,
  end_date             date,
  general_instructions text,
  published_at         timestamptz,
  locked_at            timestamptz,
  cancelled_at         timestamptz,
  cancel_reason        text,
  created_by           uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exams_name UNIQUE (school_id, session_id, name)
);

COMMENT ON TABLE public.exams IS
  'Exam event. draft -> published -> ongoing -> completed -> locked; '
  'cancelled reachable from draft/published/ongoing. All transitions via RPCs.';

-- ------------------------------------------------------------
-- exam_classes - which class-sections sit the exam
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_classes (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  exam_id     uuid        NOT NULL REFERENCES public.exams(id)    ON DELETE CASCADE,
  class_id    uuid        NOT NULL REFERENCES public.classes(id)  ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exam_classes UNIQUE (exam_id, class_id)
);

-- ------------------------------------------------------------
-- exam_subjects - one row = one paper (exam x class x subject).
-- Doubles as the timetable (date/time/room live here by design).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_subjects (
  id                  uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id           uuid        NOT NULL REFERENCES public.schools(id)   ON DELETE CASCADE,
  exam_id             uuid        NOT NULL REFERENCES public.exams(id)     ON DELETE CASCADE,
  class_id            uuid        NOT NULL REFERENCES public.classes(id)   ON DELETE RESTRICT,
  subject_id          uuid        NOT NULL REFERENCES public.subjects(id)  ON DELETE RESTRICT,
  max_marks_theory    numeric(6,2) NOT NULL DEFAULT 100 CHECK (max_marks_theory   >= 0),
  max_marks_practical numeric(6,2) NOT NULL DEFAULT 0   CHECK (max_marks_practical >= 0),
  max_marks_internal  numeric(6,2) NOT NULL DEFAULT 0   CHECK (max_marks_internal  >= 0),
  total_max_marks     numeric(7,2) GENERATED ALWAYS AS
                        (max_marks_theory + max_marks_practical + max_marks_internal) STORED,
  pass_marks          numeric(6,2) NOT NULL DEFAULT 33  CHECK (pass_marks >= 0),
  weightage_percent   numeric(5,2) NOT NULL DEFAULT 100
                                   CHECK (weightage_percent >= 0 AND weightage_percent <= 100),
  is_optional         boolean     NOT NULL DEFAULT false,
  is_cancelled        boolean     NOT NULL DEFAULT false,
  exam_date           date,
  start_time          time,
  reporting_time      time,
  duration_minutes    integer     CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  room_id             uuid        REFERENCES public.exam_rooms(id) ON DELETE SET NULL,
  instructions        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exam_subjects UNIQUE (exam_id, class_id, subject_id),
  CONSTRAINT ck_exam_subject_pass CHECK
    (pass_marks <= max_marks_theory + max_marks_practical + max_marks_internal),
  CONSTRAINT ck_exam_subject_reporting CHECK
    (reporting_time IS NULL OR start_time IS NULL OR reporting_time <= start_time)
);

COMMENT ON TABLE public.exam_subjects IS
  'One paper. The exam timetable IS this table (no separate table by design - '
  'see docs/exam-module Step 2). is_cancelled = partial exam cancellation.';

-- ------------------------------------------------------------
-- exam_enrollments - who sits the exam, with exam roll number.
-- Writes are RPC-only (generate / set status).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_enrollments (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id    uuid        NOT NULL REFERENCES public.schools(id)   ON DELETE CASCADE,
  exam_id      uuid        NOT NULL REFERENCES public.exams(id)     ON DELETE CASCADE,
  student_id   uuid        NOT NULL REFERENCES public.students(id)  ON DELETE CASCADE,
  class_id     uuid        NOT NULL REFERENCES public.classes(id)   ON DELETE RESTRICT,
  roll_number  integer     NOT NULL CHECK (roll_number > 0),
  room_id      uuid        REFERENCES public.exam_rooms(id) ON DELETE SET NULL,
  seat_number  text,
  status       text        NOT NULL DEFAULT 'enrolled'
                           CHECK (status IN ('enrolled','exempted','withdrawn','transferred')),
  remarks      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exam_enrollments_student UNIQUE (exam_id, student_id),
  CONSTRAINT uq_exam_enrollments_roll    UNIQUE (exam_id, class_id, roll_number)
);

-- ------------------------------------------------------------
-- student_subject_overrides - session-scoped exemptions and
-- optional-subject selections
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.student_subject_overrides (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id)            ON DELETE CASCADE,
  session_id  uuid        NOT NULL REFERENCES public.academic_sessions(id)  ON DELETE CASCADE,
  student_id  uuid        NOT NULL REFERENCES public.students(id)           ON DELETE CASCADE,
  subject_id  uuid        NOT NULL REFERENCES public.subjects(id)           ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('exempted','optional_selected')),
  reason      text,
  created_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_student_subject_overrides UNIQUE (session_id, student_id, subject_id)
);

-- ------------------------------------------------------------
-- exam_audit_log - module-wide append-only audit
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_audit_log (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id    uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  entity_type  text        NOT NULL,
  entity_id    uuid,
  action       text        NOT NULL,
  old_values   jsonb,
  new_values   jsonb,
  actor_id     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.exam_audit_log IS
  'Append-only. No UPDATE/DELETE policies for anyone, by design (Step 9 T8).';


-- ============================================================
-- SECTION 2: INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_acad_sessions_school     ON public.academic_sessions(school_id, status);
CREATE INDEX IF NOT EXISTS idx_acad_terms_session       ON public.academic_terms(session_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_acad_terms_school        ON public.academic_terms(school_id);
CREATE INDEX IF NOT EXISTS idx_exam_types_school        ON public.exam_types(school_id, is_active);
CREATE INDEX IF NOT EXISTS idx_exam_rooms_school        ON public.exam_rooms(school_id, is_active);
CREATE INDEX IF NOT EXISTS idx_exams_school_session     ON public.exams(school_id, session_id, status);
CREATE INDEX IF NOT EXISTS idx_exams_session            ON public.exams(session_id);
CREATE INDEX IF NOT EXISTS idx_exams_term               ON public.exams(term_id);
CREATE INDEX IF NOT EXISTS idx_exams_type               ON public.exams(exam_type_id);
CREATE INDEX IF NOT EXISTS idx_exams_status_dates       ON public.exams(status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_exam_classes_school      ON public.exam_classes(school_id);
CREATE INDEX IF NOT EXISTS idx_exam_classes_class       ON public.exam_classes(class_id);
CREATE INDEX IF NOT EXISTS idx_exam_subjects_school     ON public.exam_subjects(school_id);
CREATE INDEX IF NOT EXISTS idx_exam_subjects_exam_date  ON public.exam_subjects(exam_id, exam_date);
CREATE INDEX IF NOT EXISTS idx_exam_subjects_class_date ON public.exam_subjects(class_id, exam_date, start_time);
CREATE INDEX IF NOT EXISTS idx_exam_subjects_subject    ON public.exam_subjects(subject_id);
CREATE INDEX IF NOT EXISTS idx_exam_subjects_room       ON public.exam_subjects(room_id);
CREATE INDEX IF NOT EXISTS idx_exam_enroll_school       ON public.exam_enrollments(school_id);
CREATE INDEX IF NOT EXISTS idx_exam_enroll_exam_class   ON public.exam_enrollments(exam_id, class_id, roll_number);
CREATE INDEX IF NOT EXISTS idx_exam_enroll_student      ON public.exam_enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_exam_enroll_room         ON public.exam_enrollments(room_id);
CREATE INDEX IF NOT EXISTS idx_sso_school               ON public.student_subject_overrides(school_id);
CREATE INDEX IF NOT EXISTS idx_sso_session_student      ON public.student_subject_overrides(session_id, student_id);
CREATE INDEX IF NOT EXISTS idx_sso_student              ON public.student_subject_overrides(student_id);
CREATE INDEX IF NOT EXISTS idx_sso_subject              ON public.student_subject_overrides(subject_id);
CREATE INDEX IF NOT EXISTS idx_exam_audit_lookup        ON public.exam_audit_log(school_id, entity_type, entity_id, created_at DESC);


-- ============================================================
-- SECTION 3: HELPER FUNCTIONS
-- ============================================================

-- ------------------------------------------------------------
-- exam_ctx_staff - caller identity for exam RPCs. Raises unless
-- an active profile with a school. INTERNAL (no grants needed:
-- called from SECURITY DEFINER functions).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exam_ctx_staff(OUT o_role text, OUT o_school uuid)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  SELECT role, school_id INTO o_role, o_school
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF o_role IS NULL OR o_school IS NULL THEN
    RAISE EXCEPTION 'Access denied: no active profile';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.exam_ctx_staff() FROM PUBLIC;

-- ------------------------------------------------------------
-- exam_ctx_admin - same, but school_admin/principal only
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exam_ctx_admin(OUT o_role text, OUT o_school uuid)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  SELECT * INTO o_role, o_school FROM public.exam_ctx_staff();
  IF o_role NOT IN ('school_admin', 'principal') THEN
    RAISE EXCEPTION 'Access denied: requires school admin or principal';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.exam_ctx_admin() FROM PUBLIC;

-- ------------------------------------------------------------
-- teaches_subject_in_class - does the caller teach this subject
-- in this class? Backbone of marks/question-paper access.
-- Sibling of teaches_in_class() (chat17 part 3).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.teaches_subject_in_class(p_subject_id uuid, p_class_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.subject_assignments sa
    WHERE sa.staff_id   = public.get_my_staff_id()
      AND sa.subject_id = p_subject_id
      AND sa.class_id   = p_class_id
  );
$$;

REVOKE ALL ON FUNCTION public.teaches_subject_in_class(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teaches_subject_in_class(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- get_current_session_id - caller school's current session
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_current_session_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT id
  FROM public.academic_sessions
  WHERE school_id = public.get_my_school_id()
    AND is_current
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_current_session_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_session_id() TO authenticated;

-- ------------------------------------------------------------
-- exam_is_mutable - exam not locked/cancelled AND session not
-- locked/archived. Used by RPCs and later-phase policies.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exam_is_mutable(p_exam_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.exams e
    JOIN public.academic_sessions s ON s.id = e.session_id
    WHERE e.id = p_exam_id
      AND e.status NOT IN ('locked', 'cancelled')
      AND s.status NOT IN ('locked', 'archived')
  );
$$;

REVOKE ALL ON FUNCTION public.exam_is_mutable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_is_mutable(uuid) TO authenticated;

-- ------------------------------------------------------------
-- log_exam_audit - INTERNAL append helper
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_exam_audit(
  p_school      uuid,
  p_entity_type text,
  p_entity_id   uuid,
  p_action      text,
  p_old         jsonb DEFAULT NULL,
  p_new         jsonb DEFAULT NULL,
  p_reason      text  DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO public.exam_audit_log
    (school_id, entity_type, entity_id, action, old_values, new_values, actor_id, reason)
  VALUES
    (p_school, p_entity_type, p_entity_id, p_action, p_old, p_new, auth.uid(), p_reason);
$$;

REVOKE ALL ON FUNCTION public.log_exam_audit(uuid, text, uuid, text, jsonb, jsonb, text) FROM PUBLIC;

-- ------------------------------------------------------------
-- lock_exam_row - INTERNAL: fetch + row-lock an exam within the
-- caller's school. Uniform 'not found' (anti-enumeration).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_exam_row(p_exam_id uuid, p_school uuid)
RETURNS public.exams
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_exam public.exams;
BEGIN
  SELECT * INTO v_exam
  FROM public.exams
  WHERE id = p_exam_id AND school_id = p_school
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;
  RETURN v_exam;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_exam_row(uuid, uuid) FROM PUBLIC;

-- ------------------------------------------------------------
-- assert_session_mutable - INTERNAL: session must exist in the
-- school and not be locked/archived.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_session_mutable(p_session_id uuid, p_school uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status
  FROM public.academic_sessions
  WHERE id = p_session_id AND school_id = p_school;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Session not found';
  END IF;
  IF v_status IN ('locked', 'archived') THEN
    RAISE EXCEPTION 'Session is % - no changes allowed', v_status;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_session_mutable(uuid, uuid) FROM PUBLIC;


-- ============================================================
-- SECTION 4: TRIGGERS
-- ============================================================

-- updated_at (reuses chat17 tg_set_updated_at)
DROP TRIGGER IF EXISTS trg_acad_sessions_updated_at ON public.academic_sessions;
CREATE TRIGGER trg_acad_sessions_updated_at
  BEFORE UPDATE ON public.academic_sessions
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP TRIGGER IF EXISTS trg_acad_terms_updated_at ON public.academic_terms;
CREATE TRIGGER trg_acad_terms_updated_at
  BEFORE UPDATE ON public.academic_terms
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP TRIGGER IF EXISTS trg_exams_updated_at ON public.exams;
CREATE TRIGGER trg_exams_updated_at
  BEFORE UPDATE ON public.exams
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP TRIGGER IF EXISTS trg_exam_subjects_updated_at ON public.exam_subjects;
CREATE TRIGGER trg_exam_subjects_updated_at
  BEFORE UPDATE ON public.exam_subjects
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP TRIGGER IF EXISTS trg_exam_enroll_updated_at ON public.exam_enrollments;
CREATE TRIGGER trg_exam_enroll_updated_at
  BEFORE UPDATE ON public.exam_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ------------------------------------------------------------
-- Same-school integrity (defense in depth beyond RLS)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_ck_term_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.academic_sessions s
                 WHERE s.id = NEW.session_id AND s.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'session does not belong to this school';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ck_term_school ON public.academic_terms;
CREATE TRIGGER trg_ck_term_school
  BEFORE INSERT OR UPDATE ON public.academic_terms
  FOR EACH ROW EXECUTE FUNCTION public.tg_ck_term_school();

CREATE OR REPLACE FUNCTION public.tg_ck_exam_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.academic_sessions s
                 WHERE s.id = NEW.session_id AND s.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'session does not belong to this school';
  END IF;
  IF NEW.term_id IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM public.academic_terms t
      WHERE t.id = NEW.term_id AND t.session_id = NEW.session_id) THEN
    RAISE EXCEPTION 'term does not belong to this session';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_types et
                 WHERE et.id = NEW.exam_type_id AND et.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'exam type does not belong to this school';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ck_exam_school ON public.exams;
CREATE TRIGGER trg_ck_exam_school
  BEFORE INSERT OR UPDATE ON public.exams
  FOR EACH ROW EXECUTE FUNCTION public.tg_ck_exam_school();

CREATE OR REPLACE FUNCTION public.tg_ck_exam_class_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.exams e
                 WHERE e.id = NEW.exam_id AND e.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'exam does not belong to this school';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.classes c
                 WHERE c.id = NEW.class_id AND c.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'class does not belong to this school';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ck_exam_class_school ON public.exam_classes;
CREATE TRIGGER trg_ck_exam_class_school
  BEFORE INSERT OR UPDATE ON public.exam_classes
  FOR EACH ROW EXECUTE FUNCTION public.tg_ck_exam_class_school();

CREATE OR REPLACE FUNCTION public.tg_ck_exam_subject_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.exams e
                 WHERE e.id = NEW.exam_id AND e.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'exam does not belong to this school';
  END IF;
  -- the (exam, class) pair must be configured in exam_classes
  IF NOT EXISTS (SELECT 1 FROM public.exam_classes ec
                 WHERE ec.exam_id = NEW.exam_id AND ec.class_id = NEW.class_id) THEN
    RAISE EXCEPTION 'class is not part of this exam';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.subjects sub
                 WHERE sub.id = NEW.subject_id AND sub.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'subject does not belong to this school';
  END IF;
  IF NEW.room_id IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM public.exam_rooms r
      WHERE r.id = NEW.room_id AND r.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'room does not belong to this school';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ck_exam_subject_school ON public.exam_subjects;
CREATE TRIGGER trg_ck_exam_subject_school
  BEFORE INSERT OR UPDATE ON public.exam_subjects
  FOR EACH ROW EXECUTE FUNCTION public.tg_ck_exam_subject_school();

CREATE OR REPLACE FUNCTION public.tg_ck_enrollment_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.exams e
                 WHERE e.id = NEW.exam_id AND e.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'exam does not belong to this school';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.students st
                 WHERE st.id = NEW.student_id AND st.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'student does not belong to this school';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_classes ec
                 WHERE ec.exam_id = NEW.exam_id AND ec.class_id = NEW.class_id) THEN
    RAISE EXCEPTION 'class is not part of this exam';
  END IF;
  IF NEW.room_id IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM public.exam_rooms r
      WHERE r.id = NEW.room_id AND r.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'room does not belong to this school';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ck_enrollment_school ON public.exam_enrollments;
CREATE TRIGGER trg_ck_enrollment_school
  BEFORE INSERT OR UPDATE ON public.exam_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.tg_ck_enrollment_school();

CREATE OR REPLACE FUNCTION public.tg_ck_override_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.academic_sessions s
                 WHERE s.id = NEW.session_id AND s.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'session does not belong to this school';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.students st
                 WHERE st.id = NEW.student_id AND st.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'student does not belong to this school';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.subjects sub
                 WHERE sub.id = NEW.subject_id AND sub.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'subject does not belong to this school';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ck_override_school ON public.student_subject_overrides;
CREATE TRIGGER trg_ck_override_school
  BEFORE INSERT OR UPDATE ON public.student_subject_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_ck_override_school();

-- ------------------------------------------------------------
-- Session-lock guards: no writes into locked/archived sessions.
-- Shared functions: one for tables carrying session_id, one for
-- exam children (they all carry exam_id).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_guard_session_lock_direct()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_session uuid;
  v_status  text;
BEGIN
  v_session := CASE WHEN TG_OP = 'DELETE' THEN OLD.session_id ELSE NEW.session_id END;

  SELECT status INTO v_status FROM public.academic_sessions WHERE id = v_session;

  -- session already gone (tenant cascade) - allow
  IF v_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF v_status IN ('locked', 'archived') THEN
    RAISE EXCEPTION 'Session is % - no changes allowed', v_status;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_session_lock_terms ON public.academic_terms;
CREATE TRIGGER trg_guard_session_lock_terms
  BEFORE INSERT OR UPDATE OR DELETE ON public.academic_terms
  FOR EACH ROW EXECUTE FUNCTION public.tg_guard_session_lock_direct();

DROP TRIGGER IF EXISTS trg_guard_session_lock_exams ON public.exams;
CREATE TRIGGER trg_guard_session_lock_exams
  BEFORE INSERT OR UPDATE OR DELETE ON public.exams
  FOR EACH ROW EXECUTE FUNCTION public.tg_guard_session_lock_direct();

DROP TRIGGER IF EXISTS trg_guard_session_lock_overrides ON public.student_subject_overrides;
CREATE TRIGGER trg_guard_session_lock_overrides
  BEFORE INSERT OR UPDATE OR DELETE ON public.student_subject_overrides
  FOR EACH ROW EXECUTE FUNCTION public.tg_guard_session_lock_direct();

CREATE OR REPLACE FUNCTION public.tg_guard_session_lock_via_exam()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_exam   uuid;
  v_status text;
BEGIN
  v_exam := CASE WHEN TG_OP = 'DELETE' THEN OLD.exam_id ELSE NEW.exam_id END;

  SELECT s.status INTO v_status
  FROM public.exams e
  JOIN public.academic_sessions s ON s.id = e.session_id
  WHERE e.id = v_exam;

  -- exam already gone (cascade delete in progress) - allow
  IF v_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF v_status IN ('locked', 'archived') THEN
    RAISE EXCEPTION 'Session is % - no changes allowed', v_status;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_session_lock_exam_classes ON public.exam_classes;
CREATE TRIGGER trg_guard_session_lock_exam_classes
  BEFORE INSERT OR UPDATE OR DELETE ON public.exam_classes
  FOR EACH ROW EXECUTE FUNCTION public.tg_guard_session_lock_via_exam();

DROP TRIGGER IF EXISTS trg_guard_session_lock_exam_subjects ON public.exam_subjects;
CREATE TRIGGER trg_guard_session_lock_exam_subjects
  BEFORE INSERT OR UPDATE OR DELETE ON public.exam_subjects
  FOR EACH ROW EXECUTE FUNCTION public.tg_guard_session_lock_via_exam();

DROP TRIGGER IF EXISTS trg_guard_session_lock_enrollments ON public.exam_enrollments;
CREATE TRIGGER trg_guard_session_lock_enrollments
  BEFORE INSERT OR UPDATE OR DELETE ON public.exam_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.tg_guard_session_lock_via_exam();

-- ------------------------------------------------------------
-- Exam-state guards (capability matrix, Step 4):
-- exam_classes: INSERT/DELETE only while draft.
-- exam_subjects: INSERT/DELETE draft; UPDATE draft = anything,
--   published = scheduling fields + instructions + is_cancelled,
--   ongoing = is_cancelled only; later states = nothing.
-- (Cascade deletes pass: parent exam row is already gone.)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_guard_exam_classes_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_exam   uuid;
  v_status text;
BEGIN
  v_exam := CASE WHEN TG_OP = 'DELETE' THEN OLD.exam_id ELSE NEW.exam_id END;
  SELECT status INTO v_status FROM public.exams WHERE id = v_exam;

  IF v_status IS NULL THEN  -- cascade
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Exam classes can only change while the exam is a draft (current: %)', v_status;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_exam_classes_state ON public.exam_classes;
CREATE TRIGGER trg_guard_exam_classes_state
  BEFORE INSERT OR UPDATE OR DELETE ON public.exam_classes
  FOR EACH ROW EXECUTE FUNCTION public.tg_guard_exam_classes_state();

CREATE OR REPLACE FUNCTION public.tg_guard_exam_subjects_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_exam   uuid;
  v_status text;
BEGIN
  v_exam := CASE WHEN TG_OP = 'DELETE' THEN OLD.exam_id ELSE NEW.exam_id END;
  SELECT status INTO v_status FROM public.exams WHERE id = v_exam;

  IF v_status IS NULL THEN  -- cascade
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'Papers can only be added or removed while the exam is a draft (current: %)', v_status;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- UPDATE
  IF v_status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF v_status = 'published' THEN
    -- core marks scheme + identity immutable after publish
    IF NEW.class_id            IS DISTINCT FROM OLD.class_id
       OR NEW.subject_id          IS DISTINCT FROM OLD.subject_id
       OR NEW.max_marks_theory    IS DISTINCT FROM OLD.max_marks_theory
       OR NEW.max_marks_practical IS DISTINCT FROM OLD.max_marks_practical
       OR NEW.max_marks_internal  IS DISTINCT FROM OLD.max_marks_internal
       OR NEW.pass_marks          IS DISTINCT FROM OLD.pass_marks
       OR NEW.weightage_percent   IS DISTINCT FROM OLD.weightage_percent
       OR NEW.is_optional         IS DISTINCT FROM OLD.is_optional THEN
      RAISE EXCEPTION 'Only schedule, room, instructions and cancellation can change after publish';
    END IF;
    RETURN NEW;
  END IF;

  IF v_status = 'ongoing' THEN
    IF NEW.is_cancelled IS DISTINCT FROM OLD.is_cancelled
       AND NEW.class_id            IS NOT DISTINCT FROM OLD.class_id
       AND NEW.subject_id          IS NOT DISTINCT FROM OLD.subject_id
       AND NEW.max_marks_theory    IS NOT DISTINCT FROM OLD.max_marks_theory
       AND NEW.max_marks_practical IS NOT DISTINCT FROM OLD.max_marks_practical
       AND NEW.max_marks_internal  IS NOT DISTINCT FROM OLD.max_marks_internal
       AND NEW.pass_marks          IS NOT DISTINCT FROM OLD.pass_marks
       AND NEW.weightage_percent   IS NOT DISTINCT FROM OLD.weightage_percent
       AND NEW.is_optional         IS NOT DISTINCT FROM OLD.is_optional
       AND NEW.exam_date           IS NOT DISTINCT FROM OLD.exam_date
       AND NEW.start_time          IS NOT DISTINCT FROM OLD.start_time
       AND NEW.reporting_time      IS NOT DISTINCT FROM OLD.reporting_time
       AND NEW.duration_minutes    IS NOT DISTINCT FROM OLD.duration_minutes
       AND NEW.room_id             IS NOT DISTINCT FROM OLD.room_id THEN
      RETURN NEW;  -- pure cancellation flip is allowed mid-exam
    END IF;
    RAISE EXCEPTION 'Only paper cancellation can change while the exam is ongoing';
  END IF;

  RAISE EXCEPTION 'Papers are read-only when the exam is % ', v_status;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_exam_subjects_state ON public.exam_subjects;
CREATE TRIGGER trg_guard_exam_subjects_state
  BEFORE INSERT OR UPDATE OR DELETE ON public.exam_subjects
  FOR EACH ROW EXECUTE FUNCTION public.tg_guard_exam_subjects_state();

-- ------------------------------------------------------------
-- Denormalize exams.start_date / end_date from papers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_sync_exam_dates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exam uuid;
BEGIN
  v_exam := CASE WHEN TG_OP = 'DELETE' THEN OLD.exam_id ELSE NEW.exam_id END;

  UPDATE public.exams e
  SET start_date = s.min_d,
      end_date   = s.max_d
  FROM (
    SELECT MIN(exam_date) AS min_d, MAX(exam_date) AS max_d
    FROM public.exam_subjects
    WHERE exam_id = v_exam AND NOT is_cancelled
  ) s
  WHERE e.id = v_exam
    AND (e.start_date IS DISTINCT FROM s.min_d OR e.end_date IS DISTINCT FROM s.max_d);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_exam_dates ON public.exam_subjects;
CREATE TRIGGER trg_sync_exam_dates
  AFTER INSERT OR DELETE OR UPDATE OF exam_date, is_cancelled ON public.exam_subjects
  FOR EACH ROW EXECUTE FUNCTION public.tg_sync_exam_dates();


-- ============================================================
-- SECTION 5: ROW LEVEL SECURITY
-- Reads via policies. Writes: exam_types/exam_rooms direct for
-- admin+principal; EVERYTHING ELSE RPC-only (no write policies).
-- ============================================================

ALTER TABLE public.academic_sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.academic_terms           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_types               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_rooms               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exams                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_classes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_subjects            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_enrollments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_subject_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_audit_log           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acad_sessions_school_read" ON public.academic_sessions;
CREATE POLICY "acad_sessions_school_read"
  ON public.academic_sessions FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "acad_terms_school_read" ON public.academic_terms;
CREATE POLICY "acad_terms_school_read"
  ON public.academic_terms FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "exam_types_school_read" ON public.exam_types;
CREATE POLICY "exam_types_school_read"
  ON public.exam_types FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "exam_types_admin_write" ON public.exam_types;
CREATE POLICY "exam_types_admin_write"
  ON public.exam_types FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "exam_rooms_school_read" ON public.exam_rooms;
CREATE POLICY "exam_rooms_school_read"
  ON public.exam_rooms FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "exam_rooms_admin_write" ON public.exam_rooms;
CREATE POLICY "exam_rooms_admin_write"
  ON public.exam_rooms FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

DROP POLICY IF EXISTS "exams_school_read" ON public.exams;
CREATE POLICY "exams_school_read"
  ON public.exams FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "exam_classes_school_read" ON public.exam_classes;
CREATE POLICY "exam_classes_school_read"
  ON public.exam_classes FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "exam_subjects_school_read" ON public.exam_subjects;
CREATE POLICY "exam_subjects_school_read"
  ON public.exam_subjects FOR SELECT
  USING ( school_id = public.get_my_school_id() );

-- enrollments: admin/principal + teachers connected to the class
DROP POLICY IF EXISTS "exam_enroll_scoped_read" ON public.exam_enrollments;
CREATE POLICY "exam_enroll_scoped_read"
  ON public.exam_enrollments FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin', 'principal')
      OR public.teaches_in_class(class_id)
      OR public.is_class_teacher_of(class_id)
    )
  );

DROP POLICY IF EXISTS "sso_school_read" ON public.student_subject_overrides;
CREATE POLICY "sso_school_read"
  ON public.student_subject_overrides FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "exam_audit_admin_read" ON public.exam_audit_log;
CREATE POLICY "exam_audit_admin_read"
  ON public.exam_audit_log FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );


-- ============================================================
-- SECTION 6: RPCs - SESSIONS AND TERMS
-- ============================================================

-- ------------------------------------------------------------
-- seed_default_exam_types - INTERNAL (called by
-- create_academic_session; idempotent)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_default_exam_types(p_school_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO public.exam_types (school_id, name, code, category)
  VALUES
    (p_school_id, 'Unit Test',   'UT', 'unit_test'),
    (p_school_id, 'Monthly Test','MT', 'monthly'),
    (p_school_id, 'Quarterly',   'QE', 'quarterly'),
    (p_school_id, 'Half Yearly', 'HY', 'half_yearly'),
    (p_school_id, 'Annual',      'AN', 'annual'),
    (p_school_id, 'Practical',   'PR', 'practical')
  ON CONFLICT DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.seed_default_exam_types(uuid) FROM PUBLIC;

-- ------------------------------------------------------------
-- create_academic_session
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_academic_session(
  p_name       text,
  p_start_date date,
  p_end_date   date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_id      uuid;
  v_has_cur boolean;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  IF COALESCE(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'Session name is required';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'Session end date must be after the start date';
  END IF;

  INSERT INTO public.academic_sessions (school_id, name, start_date, end_date, created_by)
  VALUES (v_school, trim(p_name), p_start_date, p_end_date, auth.uid())
  RETURNING id INTO v_id;

  -- first session of the school becomes current + active automatically
  SELECT EXISTS (
    SELECT 1 FROM public.academic_sessions
    WHERE school_id = v_school AND is_current AND id <> v_id
  ) INTO v_has_cur;

  IF NOT v_has_cur THEN
    UPDATE public.academic_sessions
    SET is_current = true, status = 'active'
    WHERE id = v_id;
  END IF;

  PERFORM public.seed_default_exam_types(v_school);
  PERFORM public.log_exam_audit(v_school, 'session', v_id, 'create',
            NULL, jsonb_build_object('name', trim(p_name)));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_academic_session(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_academic_session(text, date, date) TO authenticated;

-- ------------------------------------------------------------
-- update_academic_session - name/dates while not locked/archived
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_academic_session(
  p_session_id uuid,
  p_name       text,
  p_start_date date,
  p_end_date   date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  PERFORM public.assert_session_mutable(p_session_id, v_school);

  IF COALESCE(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'Session name is required';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'Session end date must be after the start date';
  END IF;
  -- terms must still fit inside the new window
  IF EXISTS (
    SELECT 1 FROM public.academic_terms t
    WHERE t.session_id = p_session_id
      AND (t.start_date < p_start_date OR t.end_date > p_end_date)
  ) THEN
    RAISE EXCEPTION 'New dates would leave one or more terms outside the session window';
  END IF;

  UPDATE public.academic_sessions
  SET name = trim(p_name), start_date = p_start_date, end_date = p_end_date
  WHERE id = p_session_id AND school_id = v_school;

  PERFORM public.log_exam_audit(v_school, 'session', p_session_id, 'update',
            NULL, jsonb_build_object('name', trim(p_name),
                                     'start_date', p_start_date, 'end_date', p_end_date));
END;
$$;

REVOKE ALL ON FUNCTION public.update_academic_session(uuid, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_academic_session(uuid, text, date, date) TO authenticated;

-- ------------------------------------------------------------
-- set_current_session - atomically moves the current flag
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_current_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_status text;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  SELECT status INTO v_status
  FROM public.academic_sessions
  WHERE id = p_session_id AND school_id = v_school
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Session not found';
  END IF;
  IF v_status IN ('locked', 'archived') THEN
    RAISE EXCEPTION 'A % session cannot be made current', v_status;
  END IF;

  UPDATE public.academic_sessions
  SET is_current = false
  WHERE school_id = v_school AND is_current AND id <> p_session_id;

  UPDATE public.academic_sessions
  SET is_current = true,
      status = CASE WHEN status = 'upcoming' THEN 'active' ELSE status END
  WHERE id = p_session_id;

  PERFORM public.log_exam_audit(v_school, 'session', p_session_id, 'set_current');
END;
$$;

REVOKE ALL ON FUNCTION public.set_current_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_current_session(uuid) TO authenticated;

-- ------------------------------------------------------------
-- lock_academic_session - refuses while exams are in flight (F5)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_academic_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_school   uuid;
  v_status   text;
  v_blockers integer;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  IF v_role <> 'school_admin' THEN
    RAISE EXCEPTION 'Access denied: only the school admin can lock a session';
  END IF;

  SELECT status INTO v_status
  FROM public.academic_sessions
  WHERE id = p_session_id AND school_id = v_school
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Session not found';
  END IF;
  IF v_status = 'locked' THEN
    RETURN;  -- idempotent
  END IF;
  IF v_status = 'archived' THEN
    RAISE EXCEPTION 'Session is archived';
  END IF;

  SELECT count(*) INTO v_blockers
  FROM public.exams
  WHERE session_id = p_session_id
    AND status NOT IN ('draft', 'locked', 'cancelled');

  IF v_blockers > 0 THEN
    RAISE EXCEPTION 'Cannot lock: % exam(s) in this session are still published/ongoing/completed - lock or cancel them first', v_blockers;
  END IF;

  UPDATE public.academic_sessions SET status = 'locked' WHERE id = p_session_id;
  PERFORM public.log_exam_audit(v_school, 'session', p_session_id, 'lock');
END;
$$;

REVOKE ALL ON FUNCTION public.lock_academic_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_academic_session(uuid) TO authenticated;

-- ------------------------------------------------------------
-- unlock_academic_session - school_admin, mandatory reason
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unlock_academic_session(p_session_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_status text;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  IF v_role <> 'school_admin' THEN
    RAISE EXCEPTION 'Access denied: only the school admin can unlock a session';
  END IF;
  IF length(COALESCE(trim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason (at least 10 characters) is required to unlock a session';
  END IF;

  SELECT status INTO v_status
  FROM public.academic_sessions
  WHERE id = p_session_id AND school_id = v_school
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Session not found';
  END IF;
  IF v_status <> 'locked' THEN
    RAISE EXCEPTION 'Only a locked session can be unlocked (current: %)', v_status;
  END IF;

  UPDATE public.academic_sessions SET status = 'active' WHERE id = p_session_id;
  PERFORM public.log_exam_audit(v_school, 'session', p_session_id, 'unlock',
            NULL, NULL, trim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_academic_session(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unlock_academic_session(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- archive_academic_session - locked and non-current only
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_academic_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_status  text;
  v_current boolean;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  IF v_role <> 'school_admin' THEN
    RAISE EXCEPTION 'Access denied: only the school admin can archive a session';
  END IF;

  SELECT status, is_current INTO v_status, v_current
  FROM public.academic_sessions
  WHERE id = p_session_id AND school_id = v_school
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Session not found';
  END IF;
  IF v_current THEN
    RAISE EXCEPTION 'The current session cannot be archived - set another session current first';
  END IF;
  IF v_status <> 'locked' THEN
    RAISE EXCEPTION 'Lock the session before archiving (current: %)', v_status;
  END IF;

  UPDATE public.academic_sessions SET status = 'archived' WHERE id = p_session_id;
  PERFORM public.log_exam_audit(v_school, 'session', p_session_id, 'archive');
END;
$$;

REVOKE ALL ON FUNCTION public.archive_academic_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_academic_session(uuid) TO authenticated;

-- ------------------------------------------------------------
-- upsert_academic_term - create/update with window + overlap checks
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_academic_term(
  p_session_id        uuid,
  p_term_id           uuid,     -- NULL = create
  p_name              text,
  p_term_type         text,
  p_sort_order        integer,
  p_start_date        date,
  p_end_date          date,
  p_weightage_percent numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_s_start date;
  v_s_end   date;
  v_id      uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  PERFORM public.assert_session_mutable(p_session_id, v_school);

  SELECT start_date, end_date INTO v_s_start, v_s_end
  FROM public.academic_sessions WHERE id = p_session_id;

  IF COALESCE(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'Term name is required';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date THEN
    RAISE EXCEPTION 'Term end date must not be before the start date';
  END IF;
  IF p_start_date < v_s_start OR p_end_date > v_s_end THEN
    RAISE EXCEPTION 'Term dates must fall inside the session (% to %)', v_s_start, v_s_end;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.academic_terms t
    WHERE t.session_id = p_session_id
      AND (p_term_id IS NULL OR t.id <> p_term_id)
      AND daterange(t.start_date, t.end_date, '[]')
          && daterange(p_start_date, p_end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'Term dates overlap another term in this session';
  END IF;

  IF p_term_id IS NULL THEN
    INSERT INTO public.academic_terms
      (school_id, session_id, name, term_type, sort_order, start_date, end_date, weightage_percent)
    VALUES
      (v_school, p_session_id, trim(p_name),
       COALESCE(p_term_type, 'term'), COALESCE(p_sort_order, 1),
       p_start_date, p_end_date, COALESCE(p_weightage_percent, 100))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.academic_terms
    SET name = trim(p_name),
        term_type = COALESCE(p_term_type, term_type),
        sort_order = COALESCE(p_sort_order, sort_order),
        start_date = p_start_date,
        end_date = p_end_date,
        weightage_percent = COALESCE(p_weightage_percent, weightage_percent)
    WHERE id = p_term_id AND session_id = p_session_id AND school_id = v_school
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Term not found';
    END IF;
  END IF;

  PERFORM public.log_exam_audit(v_school, 'session', p_session_id,
            CASE WHEN p_term_id IS NULL THEN 'term_create' ELSE 'term_update' END,
            NULL, jsonb_build_object('term_id', v_id, 'name', trim(p_name)));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_academic_term(uuid, uuid, text, text, integer, date, date, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_academic_term(uuid, uuid, text, text, integer, date, date, numeric) TO authenticated;

-- ------------------------------------------------------------
-- delete_academic_term - friendly check before the FK RESTRICT
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_academic_term(p_term_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_session uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  SELECT session_id INTO v_session
  FROM public.academic_terms
  WHERE id = p_term_id AND school_id = v_school;

  IF v_session IS NULL THEN
    RAISE EXCEPTION 'Term not found';
  END IF;
  PERFORM public.assert_session_mutable(v_session, v_school);

  IF EXISTS (SELECT 1 FROM public.exams WHERE term_id = p_term_id) THEN
    RAISE EXCEPTION 'This term has exams - it cannot be deleted';
  END IF;

  DELETE FROM public.academic_terms WHERE id = p_term_id;
  PERFORM public.log_exam_audit(v_school, 'session', v_session, 'term_delete',
            jsonb_build_object('term_id', p_term_id), NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_academic_term(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_academic_term(uuid) TO authenticated;


-- ============================================================
-- SECTION 7: RPCs - EXAM LIFECYCLE AND CONFIGURATION
-- ============================================================

-- ------------------------------------------------------------
-- create_exam
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_exam(
  p_session_id   uuid,
  p_exam_type_id uuid,
  p_name         text,
  p_term_id      uuid DEFAULT NULL,
  p_instructions text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_school   uuid;
  v_s_status text;
  v_id       uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  SELECT status INTO v_s_status
  FROM public.academic_sessions
  WHERE id = p_session_id AND school_id = v_school;

  IF v_s_status IS NULL THEN
    RAISE EXCEPTION 'Session not found';
  END IF;
  IF v_s_status NOT IN ('upcoming', 'active') THEN
    RAISE EXCEPTION 'Exams can only be created in an upcoming or active session';
  END IF;
  IF COALESCE(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'Exam name is required';
  END IF;

  INSERT INTO public.exams (school_id, session_id, term_id, exam_type_id, name,
                            general_instructions, created_by)
  VALUES (v_school, p_session_id, p_term_id, p_exam_type_id, trim(p_name),
          p_instructions, auth.uid())
  RETURNING id INTO v_id;

  PERFORM public.log_exam_audit(v_school, 'exam', v_id, 'create',
            NULL, jsonb_build_object('name', trim(p_name)));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_exam(uuid, uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_exam(uuid, uuid, text, uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- update_exam - draft only
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_exam(
  p_exam_id      uuid,
  p_name         text,
  p_exam_type_id uuid,
  p_term_id      uuid DEFAULT NULL,
  p_instructions text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   public.exams;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft exam can be edited (current: %)', v_exam.status;
  END IF;
  IF COALESCE(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'Exam name is required';
  END IF;

  UPDATE public.exams
  SET name = trim(p_name),
      exam_type_id = COALESCE(p_exam_type_id, exam_type_id),
      term_id = p_term_id,
      general_instructions = p_instructions
  WHERE id = p_exam_id;

  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'update',
            NULL, jsonb_build_object('name', trim(p_name)));
END;
$$;

REVOKE ALL ON FUNCTION public.update_exam(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_exam(uuid, text, uuid, uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- set_exam_classes - replace the class set (draft only)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_exam_classes(p_exam_id uuid, p_class_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_exam    public.exams;
  v_valid   integer;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status <> 'draft' THEN
    RAISE EXCEPTION 'Classes can only change while the exam is a draft (current: %)', v_exam.status;
  END IF;
  IF p_class_ids IS NULL OR array_length(p_class_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one class is required';
  END IF;

  SELECT count(*) INTO v_valid
  FROM public.classes
  WHERE id = ANY (p_class_ids) AND school_id = v_school;
  IF v_valid <> array_length(p_class_ids, 1) THEN
    RAISE EXCEPTION 'One or more classes not found';
  END IF;

  -- removing a class removes its papers (draft: no marks exist yet)
  DELETE FROM public.exam_subjects
  WHERE exam_id = p_exam_id AND NOT (class_id = ANY (p_class_ids));

  DELETE FROM public.exam_classes
  WHERE exam_id = p_exam_id AND NOT (class_id = ANY (p_class_ids));

  INSERT INTO public.exam_classes (school_id, exam_id, class_id)
  SELECT v_school, p_exam_id, cid
  FROM unnest(p_class_ids) AS cid
  ON CONFLICT (exam_id, class_id) DO NOTHING;

  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'set_classes',
            NULL, jsonb_build_object('class_ids', to_jsonb(p_class_ids)));
END;
$$;

REVOKE ALL ON FUNCTION public.set_exam_classes(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_exam_classes(uuid, uuid[]) TO authenticated;

-- ------------------------------------------------------------
-- upsert_exam_subjects - bulk paper config.
-- Draft: full upsert. Published: schedule fields only.
-- Row shape: { class_id, subject_id, max_marks_theory,
--   max_marks_practical, max_marks_internal, pass_marks,
--   weightage_percent, is_optional, exam_date, start_time,
--   reporting_time, duration_minutes, room_id, instructions }
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_exam_subjects(p_exam_id uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   public.exams;
  v_row    jsonb;
  v_saved  integer := 0;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status NOT IN ('draft', 'published') THEN
    RAISE EXCEPTION 'Papers can only be configured while the exam is draft or published (current: %)', v_exam.status;
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'No rows supplied';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    IF v_exam.status = 'draft' THEN
      INSERT INTO public.exam_subjects
        (school_id, exam_id, class_id, subject_id,
         max_marks_theory, max_marks_practical, max_marks_internal,
         pass_marks, weightage_percent, is_optional,
         exam_date, start_time, reporting_time, duration_minutes,
         room_id, instructions)
      VALUES
        (v_school, p_exam_id,
         (v_row->>'class_id')::uuid,
         (v_row->>'subject_id')::uuid,
         COALESCE((v_row->>'max_marks_theory')::numeric,    100),
         COALESCE((v_row->>'max_marks_practical')::numeric, 0),
         COALESCE((v_row->>'max_marks_internal')::numeric,  0),
         COALESCE((v_row->>'pass_marks')::numeric,          33),
         COALESCE((v_row->>'weightage_percent')::numeric,   100),
         COALESCE((v_row->>'is_optional')::boolean,         false),
         (v_row->>'exam_date')::date,
         (v_row->>'start_time')::time,
         (v_row->>'reporting_time')::time,
         (v_row->>'duration_minutes')::integer,
         (v_row->>'room_id')::uuid,
         v_row->>'instructions')
      ON CONFLICT (exam_id, class_id, subject_id) DO UPDATE SET
         max_marks_theory    = EXCLUDED.max_marks_theory,
         max_marks_practical = EXCLUDED.max_marks_practical,
         max_marks_internal  = EXCLUDED.max_marks_internal,
         pass_marks          = EXCLUDED.pass_marks,
         weightage_percent   = EXCLUDED.weightage_percent,
         is_optional         = EXCLUDED.is_optional,
         exam_date           = EXCLUDED.exam_date,
         start_time          = EXCLUDED.start_time,
         reporting_time      = EXCLUDED.reporting_time,
         duration_minutes    = EXCLUDED.duration_minutes,
         room_id             = EXCLUDED.room_id,
         instructions        = EXCLUDED.instructions;
    ELSE
      -- published: schedule-only. Reject (never silently ignore) an
      -- attempt to change the marks scheme of an existing paper.
      IF EXISTS (
        SELECT 1 FROM public.exam_subjects es
        WHERE es.exam_id = p_exam_id
          AND es.class_id  = (v_row->>'class_id')::uuid
          AND es.subject_id = (v_row->>'subject_id')::uuid
          AND (
            (v_row ? 'max_marks_theory'    AND (v_row->>'max_marks_theory')::numeric    IS DISTINCT FROM es.max_marks_theory)
         OR (v_row ? 'max_marks_practical' AND (v_row->>'max_marks_practical')::numeric IS DISTINCT FROM es.max_marks_practical)
         OR (v_row ? 'max_marks_internal'  AND (v_row->>'max_marks_internal')::numeric  IS DISTINCT FROM es.max_marks_internal)
         OR (v_row ? 'pass_marks'          AND (v_row->>'pass_marks')::numeric          IS DISTINCT FROM es.pass_marks)
         OR (v_row ? 'weightage_percent'   AND (v_row->>'weightage_percent')::numeric   IS DISTINCT FROM es.weightage_percent)
         OR (v_row ? 'is_optional'         AND (v_row->>'is_optional')::boolean         IS DISTINCT FROM es.is_optional)
          )
      ) THEN
        RAISE EXCEPTION 'Only schedule, room and instructions can change after publish';
      END IF;

      UPDATE public.exam_subjects
      SET exam_date        = (v_row->>'exam_date')::date,
          start_time       = (v_row->>'start_time')::time,
          reporting_time   = (v_row->>'reporting_time')::time,
          duration_minutes = (v_row->>'duration_minutes')::integer,
          room_id          = (v_row->>'room_id')::uuid,
          instructions     = COALESCE(v_row->>'instructions', instructions)
      WHERE exam_id   = p_exam_id
        AND class_id  = (v_row->>'class_id')::uuid
        AND subject_id = (v_row->>'subject_id')::uuid;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Paper not found for schedule update (new papers cannot be added after publish)';
      END IF;
    END IF;
    v_saved := v_saved + 1;
  END LOOP;

  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'upsert_subjects',
            NULL, jsonb_build_object('rows', v_saved));
  RETURN jsonb_build_object('saved', v_saved);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_exam_subjects(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_exam_subjects(uuid, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- delete_exam_subject - draft only
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_exam_subject(p_exam_subject_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  SELECT exam_id INTO v_exam
  FROM public.exam_subjects
  WHERE id = p_exam_subject_id AND school_id = v_school;

  IF v_exam IS NULL THEN
    RAISE EXCEPTION 'Paper not found';
  END IF;

  DELETE FROM public.exam_subjects WHERE id = p_exam_subject_id;
  -- state guard trigger enforces draft-only

  PERFORM public.log_exam_audit(v_school, 'exam', v_exam, 'delete_subject',
            jsonb_build_object('exam_subject_id', p_exam_subject_id), NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_exam_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_exam_subject(uuid) TO authenticated;

-- ------------------------------------------------------------
-- cancel_exam_subject - partial cancellation (Step 8 case 2)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_exam_subject(p_exam_subject_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   uuid;
  v_status text;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  IF length(COALESCE(trim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason (at least 10 characters) is required to cancel a paper';
  END IF;

  SELECT es.exam_id, e.status INTO v_exam, v_status
  FROM public.exam_subjects es
  JOIN public.exams e ON e.id = es.exam_id
  WHERE es.id = p_exam_subject_id AND es.school_id = v_school;

  IF v_exam IS NULL THEN
    RAISE EXCEPTION 'Paper not found';
  END IF;
  IF v_status NOT IN ('published', 'ongoing') THEN
    RAISE EXCEPTION 'Papers can only be cancelled while the exam is published or ongoing (current: %)', v_status;
  END IF;

  UPDATE public.exam_subjects SET is_cancelled = true WHERE id = p_exam_subject_id;

  PERFORM public.log_exam_audit(v_school, 'exam', v_exam, 'cancel_subject',
            jsonb_build_object('exam_subject_id', p_exam_subject_id), NULL, trim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_exam_subject(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_exam_subject(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- publish_exam - validates, flips status, generates enrollments.
-- (WhatsApp notification enqueue arrives in chat24 via
--  CREATE OR REPLACE of this function.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_exam(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_school   uuid;
  v_exam     public.exams;
  v_s_status text;
  v_errors   text;
  v_result   jsonb;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft exam can be published (current: %)', v_exam.status;
  END IF;

  SELECT status INTO v_s_status
  FROM public.academic_sessions WHERE id = v_exam.session_id;
  IF v_s_status <> 'active' THEN
    RAISE EXCEPTION 'The exam session must be active to publish (current: %)', v_s_status;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.exam_classes WHERE exam_id = p_exam_id) THEN
    RAISE EXCEPTION 'Add at least one class before publishing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.exam_classes ec
    WHERE ec.exam_id = p_exam_id
      AND NOT EXISTS (
        SELECT 1 FROM public.exam_subjects es
        WHERE es.exam_id = p_exam_id
          AND es.class_id = ec.class_id
          AND NOT es.is_cancelled
      )
  ) THEN
    RAISE EXCEPTION 'Every class needs at least one paper before publishing';
  END IF;

  SELECT string_agg(v.message, ' | ') INTO v_errors
  FROM (
    SELECT message FROM public.validate_exam_timetable(p_exam_id)
    WHERE severity = 'error'
    LIMIT 5
  ) v;
  IF v_errors IS NOT NULL THEN
    RAISE EXCEPTION 'Timetable has errors: %', v_errors;
  END IF;

  UPDATE public.exams
  SET status = 'published', published_at = now()
  WHERE id = p_exam_id;

  v_result := public.generate_exam_enrollments(p_exam_id);

  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'publish',
            jsonb_build_object('status', 'draft'),
            jsonb_build_object('status', 'published') || v_result);

  RETURN jsonb_build_object('status', 'published') || v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_exam(uuid) TO authenticated;

-- ------------------------------------------------------------
-- unpublish_exam - back to draft. v1: allowed while published;
-- deletes enrollments (regenerated on republish). chat22/23
-- strengthen with admit-card and marks checks.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unpublish_exam(p_exam_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   public.exams;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status <> 'published' THEN
    RAISE EXCEPTION 'Only a published exam can be unpublished (current: %)', v_exam.status;
  END IF;

  DELETE FROM public.exam_enrollments WHERE exam_id = p_exam_id;

  UPDATE public.exams
  SET status = 'draft', published_at = NULL
  WHERE id = p_exam_id;

  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'unpublish',
            jsonb_build_object('status', 'published'),
            jsonb_build_object('status', 'draft'));
END;
$$;

REVOKE ALL ON FUNCTION public.unpublish_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unpublish_exam(uuid) TO authenticated;

-- ------------------------------------------------------------
-- start_exam / complete_exam / lock_exam / unlock_exam
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_exam(p_exam_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   public.exams;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status <> 'published' THEN
    RAISE EXCEPTION 'Only a published exam can be started (current: %)', v_exam.status;
  END IF;

  UPDATE public.exams SET status = 'ongoing' WHERE id = p_exam_id;
  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'start');
END;
$$;

REVOKE ALL ON FUNCTION public.start_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_exam(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_exam(p_exam_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   public.exams;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status <> 'ongoing' THEN
    RAISE EXCEPTION 'Only an ongoing exam can be completed (current: %)', v_exam.status;
  END IF;

  UPDATE public.exams SET status = 'completed' WHERE id = p_exam_id;
  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'complete');
END;
$$;

REVOKE ALL ON FUNCTION public.complete_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_exam(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.lock_exam(p_exam_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   public.exams;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status <> 'completed' THEN
    RAISE EXCEPTION 'Only a completed exam can be locked (current: %)', v_exam.status;
  END IF;

  UPDATE public.exams SET status = 'locked', locked_at = now() WHERE id = p_exam_id;
  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'lock');
END;
$$;

REVOKE ALL ON FUNCTION public.lock_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_exam(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.unlock_exam(p_exam_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   public.exams;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  IF v_role <> 'school_admin' THEN
    RAISE EXCEPTION 'Access denied: only the school admin can unlock an exam';
  END IF;
  IF length(COALESCE(trim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason (at least 10 characters) is required to unlock an exam';
  END IF;

  v_exam := public.lock_exam_row(p_exam_id, v_school);
  IF v_exam.status <> 'locked' THEN
    RAISE EXCEPTION 'Only a locked exam can be unlocked (current: %)', v_exam.status;
  END IF;

  UPDATE public.exams SET status = 'completed', locked_at = NULL WHERE id = p_exam_id;
  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'unlock', NULL, NULL, trim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_exam(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unlock_exam(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- cancel_exam - draft/published/ongoing; ongoing needs admin.
-- (Admit-card revocation side effect arrives with chat22.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_exam(p_exam_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   public.exams;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  IF length(COALESCE(trim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason (at least 10 characters) is required to cancel an exam';
  END IF;

  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status NOT IN ('draft', 'published', 'ongoing') THEN
    RAISE EXCEPTION 'A % exam cannot be cancelled', v_exam.status;
  END IF;
  IF v_exam.status = 'ongoing' AND v_role <> 'school_admin' THEN
    RAISE EXCEPTION 'Access denied: only the school admin can cancel an ongoing exam';
  END IF;

  UPDATE public.exams
  SET status = 'cancelled', cancelled_at = now(), cancel_reason = trim(p_reason)
  WHERE id = p_exam_id;

  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'cancel',
            jsonb_build_object('status', v_exam.status),
            jsonb_build_object('status', 'cancelled'), trim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_exam(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_exam(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- delete_exam - draft/cancelled only (report_cards FK will also
-- RESTRICT from chat24 onward)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_exam(p_exam_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   public.exams;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status NOT IN ('draft', 'cancelled') THEN
    RAISE EXCEPTION 'Only a draft or cancelled exam can be deleted (current: %)', v_exam.status;
  END IF;

  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'delete',
            jsonb_build_object('name', v_exam.name, 'status', v_exam.status), NULL);

  DELETE FROM public.exams WHERE id = p_exam_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_exam(uuid) TO authenticated;


-- ============================================================
-- SECTION 8: RPCs - TIMETABLE VALIDATION v1, ENROLLMENTS,
--            OVERRIDES
-- ============================================================

-- ------------------------------------------------------------
-- validate_exam_timetable v1
-- Rules: MISSING_SCHEDULE (error), CLASS_OVERLAP (error),
--        SAME_DAY_LOAD (warning).
-- chat22 extends with HOLIDAY_CLASH / ROOM_* via CREATE OR REPLACE.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_exam_timetable(p_exam_id uuid)
RETURNS TABLE (
  severity        text,
  code            text,
  exam_subject_id uuid,
  class_label     text,
  subject_name    text,
  message         text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();

  IF NOT EXISTS (SELECT 1 FROM public.exams e
                 WHERE e.id = p_exam_id AND e.school_id = v_school) THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  RETURN QUERY
  -- MISSING_SCHEDULE
  SELECT 'error'::text, 'MISSING_SCHEDULE'::text, es.id,
         (c.name || COALESCE('-' || c.section, ''))::text, sub.name,
         (sub.name || ' (' || c.name || COALESCE('-' || c.section, '')
          || '): date, time or duration missing')::text
  FROM public.exam_subjects es
  JOIN public.classes  c   ON c.id = es.class_id
  JOIN public.subjects sub ON sub.id = es.subject_id
  WHERE es.exam_id = p_exam_id
    AND NOT es.is_cancelled
    AND (es.exam_date IS NULL OR es.start_time IS NULL OR es.duration_minutes IS NULL)

  UNION ALL
  -- CLASS_OVERLAP: same class, same date, overlapping time windows
  SELECT 'error'::text, 'CLASS_OVERLAP'::text, a.id,
         (c.name || COALESCE('-' || c.section, ''))::text, sa.name,
         (c.name || COALESCE('-' || c.section, '') || ': ' || sa.name || ' overlaps '
          || sb.name || ' on ' || to_char(a.exam_date, 'DD Mon'))::text
  FROM public.exam_subjects a
  JOIN public.exam_subjects b
    ON b.exam_id = a.exam_id
   AND b.class_id = a.class_id
   AND b.exam_date = a.exam_date
   AND b.id > a.id
   AND NOT b.is_cancelled
   AND b.start_time IS NOT NULL AND b.duration_minutes IS NOT NULL
  JOIN public.classes  c  ON c.id = a.class_id
  JOIN public.subjects sa ON sa.id = a.subject_id
  JOIN public.subjects sb ON sb.id = b.subject_id
  WHERE a.exam_id = p_exam_id
    AND NOT a.is_cancelled
    AND a.start_time IS NOT NULL AND a.duration_minutes IS NOT NULL
    AND (a.exam_date + a.start_time,
         a.exam_date + a.start_time + make_interval(mins => a.duration_minutes))
        OVERLAPS
        (b.exam_date + b.start_time,
         b.exam_date + b.start_time + make_interval(mins => b.duration_minutes))

  UNION ALL
  -- SAME_DAY_LOAD: >1 non-overlapping paper for a class in a day
  SELECT 'warning'::text, 'SAME_DAY_LOAD'::text, a.id,
         (c.name || COALESCE('-' || c.section, ''))::text, sa.name,
         (c.name || COALESCE('-' || c.section, '') || ': ' || sa.name || ' and '
          || sb.name || ' fall on the same day (' || to_char(a.exam_date, 'DD Mon') || ')')::text
  FROM public.exam_subjects a
  JOIN public.exam_subjects b
    ON b.exam_id = a.exam_id
   AND b.class_id = a.class_id
   AND b.exam_date = a.exam_date
   AND b.id > a.id
   AND NOT b.is_cancelled
   AND b.start_time IS NOT NULL AND b.duration_minutes IS NOT NULL
  JOIN public.classes  c  ON c.id = a.class_id
  JOIN public.subjects sa ON sa.id = a.subject_id
  JOIN public.subjects sb ON sb.id = b.subject_id
  WHERE a.exam_id = p_exam_id
    AND NOT a.is_cancelled
    AND a.start_time IS NOT NULL AND a.duration_minutes IS NOT NULL
    AND NOT (a.exam_date + a.start_time,
             a.exam_date + a.start_time + make_interval(mins => a.duration_minutes))
            OVERLAPS
            (b.exam_date + b.start_time,
             b.exam_date + b.start_time + make_interval(mins => b.duration_minutes));
END;
$$;

REVOKE ALL ON FUNCTION public.validate_exam_timetable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_exam_timetable(uuid) TO authenticated;

-- ------------------------------------------------------------
-- generate_exam_enrollments - idempotent append (late admission
-- safe: existing rolls never renumber)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_exam_enrollments(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_school   uuid;
  v_exam     public.exams;
  v_inserted integer;
  v_total    integer;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status NOT IN ('published', 'ongoing') THEN
    RAISE EXCEPTION 'Enrollments can only be generated for a published or ongoing exam (current: %)', v_exam.status;
  END IF;

  INSERT INTO public.exam_enrollments
    (school_id, exam_id, student_id, class_id, roll_number)
  SELECT v_school, p_exam_id, s.id, s.class_id,
         COALESCE(m.max_roll, 0)
           + ROW_NUMBER() OVER (PARTITION BY s.class_id ORDER BY s.full_name, s.id)
  FROM public.students s
  JOIN public.exam_classes ec
    ON ec.exam_id = p_exam_id AND ec.class_id = s.class_id
  LEFT JOIN (
    SELECT class_id, MAX(roll_number) AS max_roll
    FROM public.exam_enrollments
    WHERE exam_id = p_exam_id
    GROUP BY class_id
  ) m ON m.class_id = s.class_id
  WHERE s.school_id = v_school
    AND s.is_active
    AND NOT EXISTS (
      SELECT 1 FROM public.exam_enrollments ee
      WHERE ee.exam_id = p_exam_id AND ee.student_id = s.id
    );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT count(*) INTO v_total
  FROM public.exam_enrollments WHERE exam_id = p_exam_id;

  IF v_inserted > 0 THEN
    PERFORM public.log_exam_audit(v_school, 'enrollment', p_exam_id, 'generate',
              NULL, jsonb_build_object('enrolled', v_inserted, 'total', v_total));
  END IF;

  RETURN jsonb_build_object('enrolled', v_inserted, 'total', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_exam_enrollments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_exam_enrollments(uuid) TO authenticated;

-- ------------------------------------------------------------
-- set_enrollment_status - exempt / withdraw / transfer / restore
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_enrollment_status(
  p_enrollment_id uuid,
  p_status        text,
  p_remarks       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_exam   uuid;
  v_old    text;
  v_estat  text;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  IF p_status NOT IN ('enrolled', 'exempted', 'withdrawn', 'transferred') THEN
    RAISE EXCEPTION 'Invalid enrollment status';
  END IF;

  SELECT ee.exam_id, ee.status, e.status INTO v_exam, v_old, v_estat
  FROM public.exam_enrollments ee
  JOIN public.exams e ON e.id = ee.exam_id
  WHERE ee.id = p_enrollment_id AND ee.school_id = v_school
  FOR UPDATE OF ee;

  IF v_exam IS NULL THEN
    RAISE EXCEPTION 'Enrollment not found';
  END IF;
  IF v_estat IN ('locked', 'cancelled') THEN
    RAISE EXCEPTION 'The exam is % - enrollment changes are not allowed', v_estat;
  END IF;

  UPDATE public.exam_enrollments
  SET status = p_status, remarks = COALESCE(p_remarks, remarks)
  WHERE id = p_enrollment_id;

  PERFORM public.log_exam_audit(v_school, 'enrollment', p_enrollment_id, 'set_status',
            jsonb_build_object('status', v_old),
            jsonb_build_object('status', p_status), p_remarks);
END;
$$;

REVOKE ALL ON FUNCTION public.set_enrollment_status(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_enrollment_status(uuid, text, text) TO authenticated;

-- ------------------------------------------------------------
-- upsert_student_subject_override / delete_student_subject_override
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_student_subject_override(
  p_session_id uuid,
  p_student_id uuid,
  p_subject_id uuid,
  p_kind       text,
  p_reason     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_id     uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  PERFORM public.assert_session_mutable(p_session_id, v_school);

  IF p_kind NOT IN ('exempted', 'optional_selected') THEN
    RAISE EXCEPTION 'Invalid override kind';
  END IF;

  INSERT INTO public.student_subject_overrides
    (school_id, session_id, student_id, subject_id, kind, reason, created_by)
  VALUES
    (v_school, p_session_id, p_student_id, p_subject_id, p_kind, p_reason, auth.uid())
  ON CONFLICT (session_id, student_id, subject_id)
  DO UPDATE SET kind = EXCLUDED.kind, reason = EXCLUDED.reason
  RETURNING id INTO v_id;

  PERFORM public.log_exam_audit(v_school, 'enrollment', v_id, 'override_upsert',
            NULL, jsonb_build_object('student_id', p_student_id,
                                     'subject_id', p_subject_id, 'kind', p_kind), p_reason);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_student_subject_override(uuid, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_student_subject_override(uuid, uuid, uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_student_subject_override(p_override_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_session uuid;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  SELECT session_id INTO v_session
  FROM public.student_subject_overrides
  WHERE id = p_override_id AND school_id = v_school;

  IF v_session IS NULL THEN
    RAISE EXCEPTION 'Override not found';
  END IF;
  PERFORM public.assert_session_mutable(v_session, v_school);

  DELETE FROM public.student_subject_overrides WHERE id = p_override_id;
  PERFORM public.log_exam_audit(v_school, 'enrollment', p_override_id, 'override_delete');
END;
$$;

REVOKE ALL ON FUNCTION public.delete_student_subject_override(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_student_subject_override(uuid) TO authenticated;

-- ------------------------------------------------------------
-- roll_exam_statuses - INTERNAL (pg_cron): date-driven flips.
-- published -> ongoing on first paper day; ongoing -> completed
-- the day after the last paper. IST dates.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.roll_exam_statuses()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_count   integer := 0;
  v_touched integer;
BEGIN
  UPDATE public.exams e
  SET status = 'ongoing'
  FROM public.academic_sessions s
  WHERE s.id = e.session_id
    AND s.status NOT IN ('locked', 'archived')
    AND e.status = 'published'
    AND e.start_date IS NOT NULL
    AND e.start_date <= v_today;
  GET DIAGNOSTICS v_touched = ROW_COUNT;
  v_count := v_count + v_touched;

  UPDATE public.exams e
  SET status = 'completed'
  FROM public.academic_sessions s
  WHERE s.id = e.session_id
    AND s.status NOT IN ('locked', 'archived')
    AND e.status = 'ongoing'
    AND e.end_date IS NOT NULL
    AND e.end_date < v_today;
  GET DIAGNOSTICS v_touched = ROW_COUNT;
  v_count := v_count + v_touched;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.roll_exam_statuses() FROM PUBLIC;


-- ============================================================
-- SECTION 9: PERMISSION SEEDS (global defaults; schools override
-- per-school via the existing role_permissions mechanism)
-- ============================================================

INSERT INTO public.role_permissions (school_id, role, permission_key, allowed)
VALUES
  -- principal: full exam administration
  (NULL, 'principal',    'sessions.manage',        true),
  (NULL, 'principal',    'exams.view',             true),
  (NULL, 'principal',    'exams.manage',           true),
  (NULL, 'principal',    'exams.publish',          true),
  (NULL, 'principal',    'exams.lock',             true),
  (NULL, 'principal',    'exam.timetable.manage',  true),
  (NULL, 'principal',    'exam.rooms.manage',      true),
  (NULL, 'principal',    'admit_cards.generate',   true),
  (NULL, 'principal',    'admit_cards.print',      true),
  (NULL, 'principal',    'question_papers.upload', true),
  (NULL, 'principal',    'exam.attendance.mark',   true),
  (NULL, 'principal',    'marks.verify',           true),
  (NULL, 'principal',    'marks.approve',          true),
  (NULL, 'principal',    'marks.reopen',           true),
  (NULL, 'principal',    'results.compute',        true),
  (NULL, 'principal',    'results.publish',        true),
  (NULL, 'principal',    'results.view',           true),
  (NULL, 'principal',    'reports.exam',           true),

  -- teacher: assigned-scope work (RLS/RPCs enforce the scoping)
  (NULL, 'teacher',      'exams.view',             true),
  (NULL, 'teacher',      'marks.enter',            true),
  (NULL, 'teacher',      'marks.verify',           true),
  (NULL, 'teacher',      'exam.attendance.mark',   true),
  (NULL, 'teacher',      'question_papers.upload', true),
  (NULL, 'teacher',      'admit_cards.print',      true),
  (NULL, 'teacher',      'results.view',           true),
  (NULL, 'teacher',      'reports.exam',           true),

  -- receptionist: schedule visibility + front-desk printing
  (NULL, 'receptionist', 'exams.view',             true),
  (NULL, 'receptionist', 'admit_cards.print',      true)
ON CONFLICT DO NOTHING;


-- ============================================================
-- SECTION 10: pg_cron - hourly exam status roll
-- ============================================================

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'roll-exam-statuses';
EXCEPTION WHEN others THEN
  NULL;
END;
$$;

SELECT cron.schedule(
  'roll-exam-statuses',
  '15 * * * *',
  $$ SELECT public.roll_exam_statuses() $$
);


-- ============================================================
-- SECTION 11: PostgREST schema reload
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION chat21_exam_sessions_core
-- ============================================================
