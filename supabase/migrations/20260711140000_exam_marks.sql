-- ============================================================
-- SCHOOLIUM - EXAM MODULE PHASE 6 - exam_marks
-- Marks entry + verification workflow (the module's core).
-- Design: docs/exam-module/ Steps 2,4,8,9 (Groups E).
-- Assumes: exam core..attendance applied.
-- ============================================================
-- Contents:
--   SECTION 1  schools.exam_grace_marks_cap (Step 8 delta)
--   SECTION 2  marks_entries, marks_submissions, marks_audit_log
--   SECTION 3  triggers: validate marks, frozen guard, audit writer
--   SECTION 4  RLS (marks_entries teacher/CT/admin read; writes
--              RPC-only. submissions scoped read. audit admin read.)
--   SECTION 5  RPCs: save_marks_bulk (autosave), the workflow
--              (submit/verify/approve/reject/freeze/reopen),
--              get_marks_grid, get_marks_board
--   SECTION 6  PostgREST schema reload
-- Idempotent throughout. Pure ASCII.
-- ============================================================


-- ============================================================
-- SECTION 1: schools - configurable grace cap
-- ============================================================

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS exam_grace_marks_cap numeric(4,1) NOT NULL DEFAULT 5
    CHECK (exam_grace_marks_cap >= 0);

COMMENT ON COLUMN public.schools.exam_grace_marks_cap IS
  'Maximum grace marks a teacher/principal may add per paper per student.';


-- ============================================================
-- SECTION 2: TABLES
-- ============================================================

-- marks_submissions - one per paper, drives the workflow
CREATE TABLE IF NOT EXISTS public.marks_submissions (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id         uuid        NOT NULL REFERENCES public.schools(id)        ON DELETE CASCADE,
  exam_subject_id   uuid        NOT NULL REFERENCES public.exam_subjects(id)  ON DELETE CASCADE,
  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','submitted','verified','approved','frozen','rejected')),
  submitted_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  submitted_at      timestamptz,
  verified_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_at       timestamptz,
  approved_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  frozen_at         timestamptz,
  rejection_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_marks_submissions UNIQUE (exam_subject_id)
);

-- marks_entries - one per (paper, student)
CREATE TABLE IF NOT EXISTS public.marks_entries (
  id                 uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id          uuid        NOT NULL REFERENCES public.schools(id)          ON DELETE CASCADE,
  exam_subject_id    uuid        NOT NULL REFERENCES public.exam_subjects(id)    ON DELETE CASCADE,
  student_id         uuid        NOT NULL REFERENCES public.students(id)         ON DELETE CASCADE,
  enrollment_id      uuid        NOT NULL REFERENCES public.exam_enrollments(id) ON DELETE CASCADE,
  theory_marks       numeric(6,2) CHECK (theory_marks    IS NULL OR theory_marks    >= 0),
  practical_marks    numeric(6,2) CHECK (practical_marks IS NULL OR practical_marks >= 0),
  internal_marks     numeric(6,2) CHECK (internal_marks  IS NULL OR internal_marks  >= 0),
  grace_marks        numeric(5,2) NOT NULL DEFAULT 0 CHECK (grace_marks >= 0),
  is_absent          boolean     NOT NULL DEFAULT false,
  is_exempted        boolean     NOT NULL DEFAULT false,
  total_marks        numeric(7,2) GENERATED ALWAYS AS (
                       CASE WHEN is_absent OR is_exempted THEN NULL
                            ELSE COALESCE(theory_marks,0) + COALESCE(practical_marks,0)
                                 + COALESCE(internal_marks,0) + COALESCE(grace_marks,0)
                       END
                     ) STORED,
  -- future-ready (Phase F): digital / OMR evaluation, moderation
  evaluation_source  text        NOT NULL DEFAULT 'manual'
                                 CHECK (evaluation_source IN ('manual','digital','omr')),
  moderation_status  text,
  entered_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_marks_entries UNIQUE (exam_subject_id, student_id),
  CONSTRAINT ck_marks_absent_exempt CHECK (NOT (is_absent AND is_exempted))
);

-- marks_audit_log - append-only
CREATE TABLE IF NOT EXISTS public.marks_audit_log (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id         uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  marks_entry_id    uuid        REFERENCES public.marks_entries(id) ON DELETE SET NULL,
  exam_subject_id   uuid        NOT NULL,
  student_id        uuid,
  action            text        NOT NULL
                                CHECK (action IN ('insert','update','delete',
                                                  'submit','verify','approve','freeze','reject','reopen')),
  old_values        jsonb,
  new_values        jsonb,
  changed_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marks_audit_log IS
  'Append-only. marks_entry_id is SET NULL on delete so history survives; '
  'exam_subject_id/student_id are denormalized copies. No UPDATE/DELETE policy.';

CREATE INDEX IF NOT EXISTS idx_marks_sub_school   ON public.marks_submissions(school_id, status);
CREATE INDEX IF NOT EXISTS idx_marks_entries_paper ON public.marks_entries(exam_subject_id);
CREATE INDEX IF NOT EXISTS idx_marks_entries_school ON public.marks_entries(school_id);
CREATE INDEX IF NOT EXISTS idx_marks_entries_student ON public.marks_entries(student_id);
CREATE INDEX IF NOT EXISTS idx_marks_entries_enroll ON public.marks_entries(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_marks_audit_paper   ON public.marks_audit_log(exam_subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marks_audit_school  ON public.marks_audit_log(school_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_marks_sub_updated_at ON public.marks_submissions;
CREATE TRIGGER trg_marks_sub_updated_at
  BEFORE UPDATE ON public.marks_submissions
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP TRIGGER IF EXISTS trg_marks_entries_updated_at ON public.marks_entries;
CREATE TRIGGER trg_marks_entries_updated_at
  BEFORE UPDATE ON public.marks_entries
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();


-- ============================================================
-- SECTION 3: TRIGGERS
-- ============================================================

-- ------------------------------------------------------------
-- tg_validate_marks - component <= its max; absent/exempt => all
-- components NULL; grace <= school cap. Runs on marks_entries.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_validate_marks()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_es    record;
  v_cap   numeric;
BEGIN
  SELECT es.max_marks_theory, es.max_marks_practical, es.max_marks_internal, es.school_id
  INTO v_es
  FROM public.exam_subjects es WHERE es.id = NEW.exam_subject_id;

  IF v_es.school_id IS NULL THEN
    RAISE EXCEPTION 'paper not found';
  END IF;

  IF NEW.is_absent OR NEW.is_exempted THEN
    IF NEW.theory_marks IS NOT NULL OR NEW.practical_marks IS NOT NULL
       OR NEW.internal_marks IS NOT NULL OR NEW.grace_marks <> 0 THEN
      RAISE EXCEPTION 'An absent or exempted student cannot have marks';
    END IF;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.theory_marks, 0)    > v_es.max_marks_theory THEN
    RAISE EXCEPTION 'Theory % exceeds max %', NEW.theory_marks, v_es.max_marks_theory;
  END IF;
  IF COALESCE(NEW.practical_marks, 0) > v_es.max_marks_practical THEN
    RAISE EXCEPTION 'Practical % exceeds max %', NEW.practical_marks, v_es.max_marks_practical;
  END IF;
  IF COALESCE(NEW.internal_marks, 0)  > v_es.max_marks_internal THEN
    RAISE EXCEPTION 'Internal % exceeds max %', NEW.internal_marks, v_es.max_marks_internal;
  END IF;

  SELECT exam_grace_marks_cap INTO v_cap FROM public.schools WHERE id = v_es.school_id;
  IF NEW.grace_marks > v_cap THEN
    RAISE EXCEPTION 'Grace % exceeds the school cap of %', NEW.grace_marks, v_cap;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_marks ON public.marks_entries;
CREATE TRIGGER trg_validate_marks
  BEFORE INSERT OR UPDATE ON public.marks_entries
  FOR EACH ROW EXECUTE FUNCTION public.tg_validate_marks();

-- ------------------------------------------------------------
-- tg_marks_frozen_guard - marks_entries writable only while the
-- paper's submission is pending/rejected. Defense in depth: fires
-- even for SECURITY DEFINER RPCs and service_role. The workflow
-- RPCs set a session flag when they legitimately need to move
-- between states (they touch marks_submissions, not marks_entries,
-- so this guard rarely needs the bypass - only reopen clears rows'
-- edit lock by moving status back to pending first).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_marks_frozen_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_paper  uuid;
BEGIN
  v_paper := CASE WHEN TG_OP = 'DELETE' THEN OLD.exam_subject_id ELSE NEW.exam_subject_id END;

  SELECT status INTO v_status
  FROM public.marks_submissions WHERE exam_subject_id = v_paper;

  -- no submission row yet => first entry, allowed
  IF v_status IS NULL OR v_status IN ('pending', 'rejected') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION 'Marks are locked (submission is %) - reopen is required to edit', v_status;
END;
$$;

DROP TRIGGER IF EXISTS trg_marks_frozen_guard ON public.marks_entries;
CREATE TRIGGER trg_marks_frozen_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.marks_entries
  FOR EACH ROW EXECUTE FUNCTION public.tg_marks_frozen_guard();

-- ------------------------------------------------------------
-- tg_marks_audit - append old/new on every marks_entries change.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_marks_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.marks_audit_log
      (school_id, marks_entry_id, exam_subject_id, student_id, action, new_values, changed_by)
    VALUES (NEW.school_id, NEW.id, NEW.exam_subject_id, NEW.student_id, 'insert',
            to_jsonb(NEW), auth.uid());
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      INSERT INTO public.marks_audit_log
        (school_id, marks_entry_id, exam_subject_id, student_id, action, old_values, new_values, changed_by)
      VALUES (NEW.school_id, NEW.id, NEW.exam_subject_id, NEW.student_id, 'update',
              to_jsonb(OLD), to_jsonb(NEW), auth.uid());
    END IF;
    RETURN NEW;
  ELSE
    INSERT INTO public.marks_audit_log
      (school_id, marks_entry_id, exam_subject_id, student_id, action, old_values, changed_by)
    VALUES (OLD.school_id, OLD.id, OLD.exam_subject_id, OLD.student_id, 'delete',
            to_jsonb(OLD), auth.uid());
    RETURN OLD;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_marks_audit ON public.marks_entries;
CREATE TRIGGER trg_marks_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.marks_entries
  FOR EACH ROW EXECUTE FUNCTION public.tg_marks_audit();


-- ============================================================
-- SECTION 4: RLS
-- ============================================================

ALTER TABLE public.marks_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marks_entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marks_audit_log   ENABLE ROW LEVEL SECURITY;

-- submissions: admin/principal all; teacher sees own papers or class papers
DROP POLICY IF EXISTS "marks_sub_scoped_read" ON public.marks_submissions;
CREATE POLICY "marks_sub_scoped_read"
  ON public.marks_submissions FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin', 'principal')
      OR EXISTS (
        SELECT 1 FROM public.exam_subjects es
        WHERE es.id = exam_subject_id
          AND ( public.teaches_subject_in_class(es.subject_id, es.class_id)
                OR public.is_class_teacher_of(es.class_id) )
      )
    )
  );

-- entries: admin/principal all; assigned subject teacher; class teacher
DROP POLICY IF EXISTS "marks_entries_scoped_read" ON public.marks_entries;
CREATE POLICY "marks_entries_scoped_read"
  ON public.marks_entries FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin', 'principal')
      OR EXISTS (
        SELECT 1 FROM public.exam_subjects es
        WHERE es.id = exam_subject_id
          AND ( public.teaches_subject_in_class(es.subject_id, es.class_id)
                OR public.is_class_teacher_of(es.class_id) )
      )
    )
  );
-- writes RPC-only (frozen guard + validate triggers still fire)

DROP POLICY IF EXISTS "marks_audit_admin_read" ON public.marks_audit_log;
CREATE POLICY "marks_audit_admin_read"
  ON public.marks_audit_log FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );


-- ============================================================
-- SECTION 5: RPCs
-- ============================================================

-- INTERNAL: get-or-create the submission row for a paper, locked.
CREATE OR REPLACE FUNCTION public.marks_ensure_submission(p_exam_subject_id uuid, p_school uuid)
RETURNS public.marks_submissions
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_sub public.marks_submissions;
BEGIN
  SELECT * INTO v_sub FROM public.marks_submissions
  WHERE exam_subject_id = p_exam_subject_id FOR UPDATE;
  IF v_sub.id IS NULL THEN
    INSERT INTO public.marks_submissions (school_id, exam_subject_id)
    VALUES (p_school, p_exam_subject_id)
    RETURNING * INTO v_sub;
  END IF;
  RETURN v_sub;
END;
$$;

REVOKE ALL ON FUNCTION public.marks_ensure_submission(uuid, uuid) FROM PUBLIC;

-- INTERNAL: paper context + permission facts for the caller
CREATE OR REPLACE FUNCTION public.marks_paper_ctx(
  p_exam_subject_id uuid, p_school uuid,
  OUT o_exam_id uuid, OUT o_class_id uuid, OUT o_subject_id uuid,
  OUT o_exam_status text, OUT o_is_cancelled boolean,
  OUT o_teaches boolean, OUT o_is_ct boolean)
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  SELECT es.exam_id, es.class_id, es.subject_id, e.status, es.is_cancelled
  INTO o_exam_id, o_class_id, o_subject_id, o_exam_status, o_is_cancelled
  FROM public.exam_subjects es
  JOIN public.exams e ON e.id = es.exam_id
  WHERE es.id = p_exam_subject_id AND es.school_id = p_school;

  IF o_exam_id IS NULL THEN
    RAISE EXCEPTION 'Paper not found';
  END IF;

  o_teaches := public.teaches_subject_in_class(o_subject_id, o_class_id);
  o_is_ct   := public.is_class_teacher_of(o_class_id);
END;
$$;

REVOKE ALL ON FUNCTION public.marks_paper_ctx(uuid, uuid) FROM PUBLIC;

-- ------------------------------------------------------------
-- save_marks_bulk - autosave. Partial success: valid rows saved,
-- invalid rows returned with reasons. Only the assigned subject
-- teacher (or admin/principal) may write, only in pending/rejected.
-- Row: { student_id, theory, practical, internal, grace,
--        is_absent, is_exempted }
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_marks_bulk(p_exam_subject_id uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_school   uuid;
  v_ctx      record;
  v_sub      public.marks_submissions;
  v_row      jsonb;
  v_enroll   uuid;
  v_saved    integer := 0;
  v_rejected jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  SELECT * INTO v_ctx FROM public.marks_paper_ctx(p_exam_subject_id, v_school);

  IF NOT (v_role IN ('school_admin','principal') OR v_ctx.o_teaches) THEN
    RAISE EXCEPTION 'Access denied: you do not teach this subject and class';
  END IF;
  IF v_ctx.o_is_cancelled THEN
    RAISE EXCEPTION 'This paper is cancelled';
  END IF;
  IF v_ctx.o_exam_status NOT IN ('ongoing','completed') THEN
    RAISE EXCEPTION 'Marks can only be entered for an ongoing or completed exam (current: %)', v_ctx.o_exam_status;
  END IF;

  v_sub := public.marks_ensure_submission(p_exam_subject_id, v_school);
  IF v_sub.status NOT IN ('pending','rejected') THEN
    RAISE EXCEPTION 'Marks are locked (submission is %) - reopen is required to edit', v_sub.status;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    BEGIN
      -- resolve enrollment (must be enrolled in this paper's class)
      SELECT ee.id INTO v_enroll
      FROM public.exam_enrollments ee
      WHERE ee.exam_id = v_ctx.o_exam_id
        AND ee.student_id = (v_row->>'student_id')::uuid
        AND ee.class_id = v_ctx.o_class_id;

      IF v_enroll IS NULL THEN
        v_rejected := v_rejected || jsonb_build_object(
          'student_id', v_row->>'student_id', 'reason', 'not enrolled in this paper');
        CONTINUE;
      END IF;

      INSERT INTO public.marks_entries
        (school_id, exam_subject_id, student_id, enrollment_id,
         theory_marks, practical_marks, internal_marks, grace_marks,
         is_absent, is_exempted, entered_by, updated_by)
      VALUES
        (v_school, p_exam_subject_id, (v_row->>'student_id')::uuid, v_enroll,
         NULLIF(v_row->>'theory','')::numeric,
         NULLIF(v_row->>'practical','')::numeric,
         NULLIF(v_row->>'internal','')::numeric,
         COALESCE(NULLIF(v_row->>'grace','')::numeric, 0),
         COALESCE((v_row->>'is_absent')::boolean, false),
         COALESCE((v_row->>'is_exempted')::boolean, false),
         auth.uid(), auth.uid())
      ON CONFLICT (exam_subject_id, student_id) DO UPDATE SET
         theory_marks    = EXCLUDED.theory_marks,
         practical_marks = EXCLUDED.practical_marks,
         internal_marks  = EXCLUDED.internal_marks,
         grace_marks     = EXCLUDED.grace_marks,
         is_absent       = EXCLUDED.is_absent,
         is_exempted     = EXCLUDED.is_exempted,
         updated_by      = auth.uid();
      v_saved := v_saved + 1;
    EXCEPTION WHEN others THEN
      v_rejected := v_rejected || jsonb_build_object(
        'student_id', v_row->>'student_id', 'reason', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('saved', v_saved, 'rejected', v_rejected);
END;
$$;

REVOKE ALL ON FUNCTION public.save_marks_bulk(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_marks_bulk(uuid, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- submit_marks - completeness + attendance cross-check, then
-- pending/rejected -> submitted. Assigned teacher (or admin).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_marks(p_exam_subject_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_ctx     record;
  v_sub     public.marks_submissions;
  v_missing integer;
  v_mismatch integer;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  SELECT * INTO v_ctx FROM public.marks_paper_ctx(p_exam_subject_id, v_school);

  IF NOT (v_role IN ('school_admin','principal') OR v_ctx.o_teaches) THEN
    RAISE EXCEPTION 'Access denied: you do not teach this subject and class';
  END IF;

  v_sub := public.marks_ensure_submission(p_exam_subject_id, v_school);
  IF v_sub.status NOT IN ('pending','rejected') THEN
    RAISE EXCEPTION 'Already submitted (status: %)', v_sub.status;
  END IF;

  -- completeness: every enrolled, non-exempt student needs an entry
  -- (with marks or is_absent). Session-exempt students are excluded.
  SELECT count(*) INTO v_missing
  FROM public.exam_enrollments ee
  WHERE ee.exam_id = v_ctx.o_exam_id
    AND ee.class_id = v_ctx.o_class_id
    AND ee.status = 'enrolled'
    AND NOT EXISTS (
      SELECT 1 FROM public.student_subject_overrides sso
      JOIN public.exams e ON e.id = v_ctx.o_exam_id
      WHERE sso.session_id = e.session_id
        AND sso.student_id = ee.student_id
        AND sso.subject_id = v_ctx.o_subject_id
        AND sso.kind = 'exempted')
    AND NOT EXISTS (
      SELECT 1 FROM public.marks_entries me
      WHERE me.exam_subject_id = p_exam_subject_id
        AND me.student_id = ee.student_id
        AND (me.is_absent OR me.is_exempted
             OR me.theory_marks IS NOT NULL OR me.practical_marks IS NOT NULL
             OR me.internal_marks IS NOT NULL));

  IF v_missing > 0 THEN
    RAISE EXCEPTION 'Cannot submit: % student(s) have no marks and are not marked absent', v_missing;
  END IF;

  -- attendance cross-check: absent/medical in the room but has marks
  SELECT count(*) INTO v_mismatch
  FROM public.exam_attendance ea
  JOIN public.marks_entries me
    ON me.exam_subject_id = ea.exam_subject_id AND me.student_id = ea.student_id
  WHERE ea.exam_subject_id = p_exam_subject_id
    AND ea.status IN ('absent','medical')
    AND NOT me.is_absent AND NOT me.is_exempted;

  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'Cannot submit: % student(s) were absent in the exam room but have marks entered', v_mismatch;
  END IF;

  UPDATE public.marks_submissions
  SET status = 'submitted', submitted_by = auth.uid(), submitted_at = now(),
      rejection_reason = NULL
  WHERE id = v_sub.id;

  INSERT INTO public.marks_audit_log
    (school_id, exam_subject_id, action, changed_by)
  VALUES (v_school, p_exam_subject_id, 'submit', auth.uid());

  RETURN jsonb_build_object('status', 'submitted');
END;
$$;

REVOKE ALL ON FUNCTION public.submit_marks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_marks(uuid) TO authenticated;

-- ------------------------------------------------------------
-- INTERNAL: workflow transition helper for CT/PR steps
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.marks_transition(
  p_exam_subject_id uuid,
  p_from            text[],
  p_to              text,
  p_actor           text,       -- 'ct' | 'principal' | 'ct_or_principal'
  p_reason          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_ctx    record;
  v_sub    public.marks_submissions;
  v_ok     boolean;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  SELECT * INTO v_ctx FROM public.marks_paper_ctx(p_exam_subject_id, v_school);

  -- authorization by actor kind
  v_ok := false;
  IF p_actor = 'ct' THEN
    v_ok := v_role IN ('school_admin','principal') OR v_ctx.o_is_ct;
  ELSIF p_actor = 'principal' THEN
    v_ok := v_role IN ('school_admin','principal');
  ELSIF p_actor = 'ct_or_principal' THEN
    v_ok := v_role IN ('school_admin','principal') OR v_ctx.o_is_ct;
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Access denied for this action';
  END IF;

  SELECT * INTO v_sub FROM public.marks_submissions
  WHERE exam_subject_id = p_exam_subject_id FOR UPDATE;
  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'No marks have been entered yet';
  END IF;
  IF NOT (v_sub.status = ANY (p_from)) THEN
    RAISE EXCEPTION 'Cannot % from status %', p_to, v_sub.status;
  END IF;

  UPDATE public.marks_submissions
  SET status = p_to,
      verified_by = CASE WHEN p_to = 'verified' THEN auth.uid() ELSE verified_by END,
      verified_at = CASE WHEN p_to = 'verified' THEN now() ELSE verified_at END,
      approved_by = CASE WHEN p_to = 'approved' THEN auth.uid() ELSE approved_by END,
      approved_at = CASE WHEN p_to = 'approved' THEN now() ELSE approved_at END,
      frozen_at   = CASE WHEN p_to = 'frozen' THEN now() ELSE frozen_at END,
      rejection_reason = CASE WHEN p_to = 'rejected' THEN p_reason ELSE rejection_reason END
  WHERE id = v_sub.id;

  INSERT INTO public.marks_audit_log
    (school_id, exam_subject_id, action, changed_by, reason)
  VALUES (v_school, p_exam_subject_id,
          CASE p_to WHEN 'verified' THEN 'verify' WHEN 'approved' THEN 'approve'
                    WHEN 'frozen' THEN 'freeze' WHEN 'rejected' THEN 'reject' ELSE p_to END,
          auth.uid(), p_reason);

  RETURN jsonb_build_object('status', p_to);
END;
$$;

REVOKE ALL ON FUNCTION public.marks_transition(uuid, text[], text, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.verify_marks(p_exam_subject_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.marks_transition(p_exam_subject_id, ARRAY['submitted'], 'verified', 'ct');
$$;
REVOKE ALL ON FUNCTION public.verify_marks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_marks(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_marks(p_exam_subject_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.marks_transition(p_exam_subject_id, ARRAY['verified'], 'approved', 'principal');
$$;
REVOKE ALL ON FUNCTION public.approve_marks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_marks(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.freeze_marks(p_exam_subject_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.marks_transition(p_exam_subject_id, ARRAY['approved'], 'frozen', 'principal');
$$;
REVOKE ALL ON FUNCTION public.freeze_marks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.freeze_marks(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_marks(p_exam_subject_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF length(COALESCE(trim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason (at least 10 characters) is required to reject marks';
  END IF;
  RETURN public.marks_transition(p_exam_subject_id, ARRAY['submitted','verified'], 'rejected', 'ct_or_principal', trim(p_reason));
END;
$$;
REVOKE ALL ON FUNCTION public.reject_marks(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_marks(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- reopen_marks - frozen/approved/verified -> pending (PR/SA only,
-- mandatory reason). Invalidates any computed result for the exam
-- (results table arrives in Phase 7; guarded with to_regclass).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reopen_marks(p_exam_subject_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_ctx    record;
  v_sub    public.marks_submissions;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  IF v_role NOT IN ('school_admin','principal') THEN
    RAISE EXCEPTION 'Access denied: only a principal or admin can reopen marks';
  END IF;
  IF length(COALESCE(trim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason (at least 10 characters) is required to reopen marks';
  END IF;

  SELECT * INTO v_ctx FROM public.marks_paper_ctx(p_exam_subject_id, v_school);

  SELECT * INTO v_sub FROM public.marks_submissions
  WHERE exam_subject_id = p_exam_subject_id FOR UPDATE;
  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'No marks to reopen';
  END IF;
  IF v_sub.status NOT IN ('submitted','verified','approved','frozen') THEN
    RAISE EXCEPTION 'Nothing to reopen (status: %)', v_sub.status;
  END IF;

  UPDATE public.marks_submissions
  SET status = 'pending', submitted_at = NULL, verified_by = NULL, verified_at = NULL,
      approved_by = NULL, approved_at = NULL, frozen_at = NULL
  WHERE id = v_sub.id;

  INSERT INTO public.marks_audit_log
    (school_id, exam_subject_id, action, changed_by, reason)
  VALUES (v_school, p_exam_subject_id, 'reopen', auth.uid(), trim(p_reason));

  -- invalidate computed results if that table exists (Phase 7)
  IF to_regclass('public.exam_results') IS NOT NULL THEN
    EXECUTE 'UPDATE public.exam_results SET is_final = false WHERE exam_id = $1'
    USING v_ctx.o_exam_id;
  END IF;

  RETURN jsonb_build_object('status', 'pending');
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_marks(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reopen_marks(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- get_marks_grid - roster + current marks + max marks + status,
-- for the entry/verification screens.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_marks_grid(p_exam_subject_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_ctx    record;
  v_es     record;
  v_status text;
  v_rows   jsonb;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  SELECT * INTO v_ctx FROM public.marks_paper_ctx(p_exam_subject_id, v_school);

  IF NOT (v_role IN ('school_admin','principal') OR v_ctx.o_teaches OR v_ctx.o_is_ct) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  SELECT es.max_marks_theory, es.max_marks_practical, es.max_marks_internal,
         es.pass_marks, es.total_max_marks
  INTO v_es FROM public.exam_subjects es WHERE es.id = p_exam_subject_id;

  SELECT status INTO v_status FROM public.marks_submissions WHERE exam_subject_id = p_exam_subject_id;

  SELECT jsonb_agg(row ORDER BY row->>'roll_number_int')
  INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'student_id', ee.student_id,
      'roll_number', ee.roll_number,
      'roll_number_int', lpad(ee.roll_number::text, 6, '0'),
      'full_name', s.full_name,
      'photo_url', s.photo_url,
      'enroll_status', ee.status,
      'session_exempted', EXISTS (
        SELECT 1 FROM public.student_subject_overrides sso
        JOIN public.exams e ON e.id = ee.exam_id
        WHERE sso.session_id = e.session_id AND sso.student_id = ee.student_id
          AND sso.subject_id = v_ctx.o_subject_id AND sso.kind = 'exempted'),
      'room_status', (SELECT ea.status FROM public.exam_attendance ea
                      WHERE ea.exam_subject_id = p_exam_subject_id AND ea.student_id = ee.student_id),
      'theory', me.theory_marks, 'practical', me.practical_marks,
      'internal', me.internal_marks, 'grace', me.grace_marks,
      'is_absent', COALESCE(me.is_absent, false),
      'is_exempted', COALESCE(me.is_exempted, false),
      'total', me.total_marks
    ) AS row
    FROM public.exam_enrollments ee
    JOIN public.students s ON s.id = ee.student_id
    LEFT JOIN public.marks_entries me
      ON me.exam_subject_id = p_exam_subject_id AND me.student_id = ee.student_id
    WHERE ee.exam_id = v_ctx.o_exam_id AND ee.class_id = v_ctx.o_class_id
      AND ee.status = 'enrolled'
  ) t;

  RETURN jsonb_build_object(
    'status', COALESCE(v_status, 'pending'),
    'max_theory', v_es.max_marks_theory,
    'max_practical', v_es.max_marks_practical,
    'max_internal', v_es.max_marks_internal,
    'pass_marks', v_es.pass_marks,
    'total_max', v_es.total_max_marks,
    'can_edit', (v_role IN ('school_admin','principal') OR v_ctx.o_teaches)
                AND COALESCE(v_status,'pending') IN ('pending','rejected')
                AND v_ctx.o_exam_status IN ('ongoing','completed'),
    'rows', COALESCE(v_rows, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_marks_grid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_marks_grid(uuid) TO authenticated;

-- ------------------------------------------------------------
-- get_marks_board - per exam: papers x submission status + progress
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_marks_board(p_exam_id uuid)
RETURNS TABLE (
  exam_subject_id uuid,
  class_label     text,
  subject_name    text,
  status          text,
  entered         integer,
  enrolled        integer,
  submitted_at    timestamptz,
  updated_at      timestamptz
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
  IF NOT EXISTS (SELECT 1 FROM public.exams e WHERE e.id = p_exam_id AND e.school_id = v_school) THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  RETURN QUERY
  SELECT es.id,
         (c.name || COALESCE('-' || c.section, ''))::text,
         sub.name,
         COALESCE(ms.status, 'pending'),
         COALESCE(cnt.n, 0)::integer,
         enr.n::integer,
         ms.submitted_at,
         ms.updated_at
  FROM public.exam_subjects es
  JOIN public.classes  c   ON c.id = es.class_id
  JOIN public.subjects sub ON sub.id = es.subject_id
  LEFT JOIN public.marks_submissions ms ON ms.exam_subject_id = es.id
  JOIN LATERAL (
    SELECT count(*) AS n FROM public.exam_enrollments ee
    WHERE ee.exam_id = es.exam_id AND ee.class_id = es.class_id AND ee.status = 'enrolled'
  ) enr ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM public.marks_entries me
    WHERE me.exam_subject_id = es.id
      AND (me.is_absent OR me.is_exempted OR me.theory_marks IS NOT NULL
           OR me.practical_marks IS NOT NULL OR me.internal_marks IS NOT NULL)
  ) cnt ON true
  WHERE es.exam_id = p_exam_id AND NOT es.is_cancelled
  ORDER BY c.name, c.section, sub.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_marks_board(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_marks_board(uuid) TO authenticated;


-- ============================================================
-- SECTION 6: PostgREST schema reload
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION exam_marks
-- ============================================================
