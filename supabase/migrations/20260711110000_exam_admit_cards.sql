-- ============================================================
-- SCHOOLIUM - EXAM MODULE PHASE 3 - exam_admit_cards
-- Design: docs/exam-module/ Steps 2-4 (Group C, admit cards).
-- Assumes: exam_sessions_core + exam_logistics applied.
-- ============================================================
-- Contents:
--   SECTION 1  admit_card_templates + admit_cards tables, RLS
--   SECTION 2  RPCs: generate_admit_cards, revoke_admit_card,
--              record_admit_card_print, verify_admit_card
--   SECTION 3  Lifecycle strengthening (promised in phase 1):
--              cancel_exam now auto-revokes admit cards;
--              unpublish_exam refuses once cards were printed
--   SECTION 4  exam_enrollments read policy: + receptionist
--              (front-desk admit card printing)
--   SECTION 5  PostgREST schema reload
-- Idempotent throughout. Pure ASCII.
-- ============================================================


-- ============================================================
-- SECTION 1: TABLES + RLS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.admit_card_templates (
  id                        uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id                 uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name                      text        NOT NULL,
  layout                    text        NOT NULL DEFAULT 'single'
                                        CHECK (layout IN ('single','two_per_a4','three_per_a4','four_per_a4')),
  instructions              text,
  principal_signature_path  text,
  show_photo                boolean     NOT NULL DEFAULT true,
  show_qr                   boolean     NOT NULL DEFAULT true,
  show_seat                 boolean     NOT NULL DEFAULT true,
  is_default                boolean     NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_admit_templates_name UNIQUE (school_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admit_templates_default
  ON public.admit_card_templates (school_id)
  WHERE is_default;

CREATE TABLE IF NOT EXISTS public.admit_cards (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id        uuid        NOT NULL REFERENCES public.schools(id)           ON DELETE CASCADE,
  exam_id          uuid        NOT NULL REFERENCES public.exams(id)             ON DELETE CASCADE,
  enrollment_id    uuid        NOT NULL REFERENCES public.exam_enrollments(id)  ON DELETE CASCADE,
  template_id      uuid        REFERENCES public.admit_card_templates(id)       ON DELETE SET NULL,
  qr_token         uuid        NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
  is_revoked       boolean     NOT NULL DEFAULT false,
  revoke_reason    text,
  print_count      integer     NOT NULL DEFAULT 0,
  last_printed_at  timestamptz,
  generated_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_admit_cards_enrollment UNIQUE (enrollment_id)
);

COMMENT ON TABLE public.admit_cards IS
  'One live card per enrollment. Regeneration after a data fix = revoke '
  '+ delete + regenerate (new QR). qr_token doubles as the exam-day '
  'attendance scan key and the verification key - no PII in the QR.';

CREATE INDEX IF NOT EXISTS idx_admit_cards_school   ON public.admit_cards(school_id);
CREATE INDEX IF NOT EXISTS idx_admit_cards_exam     ON public.admit_cards(exam_id);
CREATE INDEX IF NOT EXISTS idx_admit_cards_template ON public.admit_cards(template_id);

CREATE OR REPLACE FUNCTION public.tg_ck_admit_card_school()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.exams e
                 WHERE e.id = NEW.exam_id AND e.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'exam does not belong to this school';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_enrollments ee
                 WHERE ee.id = NEW.enrollment_id AND ee.exam_id = NEW.exam_id) THEN
    RAISE EXCEPTION 'enrollment does not belong to this exam';
  END IF;
  IF NEW.template_id IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM public.admit_card_templates t
      WHERE t.id = NEW.template_id AND t.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'template does not belong to this school';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ck_admit_card_school ON public.admit_cards;
CREATE TRIGGER trg_ck_admit_card_school
  BEFORE INSERT OR UPDATE ON public.admit_cards
  FOR EACH ROW EXECUTE FUNCTION public.tg_ck_admit_card_school();

ALTER TABLE public.admit_card_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admit_cards          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admit_templates_school_read" ON public.admit_card_templates;
CREATE POLICY "admit_templates_school_read"
  ON public.admit_card_templates FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "admit_templates_admin_write" ON public.admit_card_templates;
CREATE POLICY "admit_templates_admin_write"
  ON public.admit_card_templates FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

-- Cards: staff roles that handle printing read them; writes RPC-only.
DROP POLICY IF EXISTS "admit_cards_staff_read" ON public.admit_cards;
CREATE POLICY "admit_cards_staff_read"
  ON public.admit_cards FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal', 'receptionist', 'teacher')
  );


-- ============================================================
-- SECTION 2: RPCs
-- ============================================================

-- ------------------------------------------------------------
-- generate_admit_cards - bulk, idempotent (skips live cards).
-- Only status='enrolled' students receive cards.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_admit_cards(
  p_exam_id     uuid,
  p_class_id    uuid DEFAULT NULL,
  p_template_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_school    uuid;
  v_exam      public.exams;
  v_template  uuid;
  v_generated integer;
  v_total     integer;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status NOT IN ('published', 'ongoing') THEN
    RAISE EXCEPTION 'Admit cards can only be generated for a published or ongoing exam (current: %)', v_exam.status;
  END IF;

  v_template := p_template_id;
  IF v_template IS NULL THEN
    SELECT id INTO v_template
    FROM public.admit_card_templates
    WHERE school_id = v_school AND is_default
    LIMIT 1;
  END IF;

  INSERT INTO public.admit_cards (school_id, exam_id, enrollment_id, template_id, generated_by)
  SELECT v_school, p_exam_id, ee.id, v_template, auth.uid()
  FROM public.exam_enrollments ee
  WHERE ee.exam_id = p_exam_id
    AND ee.status = 'enrolled'
    AND (p_class_id IS NULL OR ee.class_id = p_class_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.admit_cards ac WHERE ac.enrollment_id = ee.id
    );

  GET DIAGNOSTICS v_generated = ROW_COUNT;

  SELECT count(*) INTO v_total
  FROM public.admit_cards
  WHERE exam_id = p_exam_id AND NOT is_revoked;

  IF v_generated > 0 THEN
    PERFORM public.log_exam_audit(v_school, 'admit_card', p_exam_id, 'generate',
              NULL, jsonb_build_object('generated', v_generated, 'total_live', v_total,
                                       'class_id', p_class_id));
  END IF;

  RETURN jsonb_build_object('generated', v_generated, 'total_live', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_admit_cards(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_admit_cards(uuid, uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- revoke_admit_card - kills the QR token; optionally the caller
-- regenerates afterwards (new row, new token).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_admit_card(p_admit_card_id uuid, p_reason text)
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
  IF length(COALESCE(trim(p_reason), '')) < 5 THEN
    RAISE EXCEPTION 'A reason is required to revoke an admit card';
  END IF;

  UPDATE public.admit_cards
  SET is_revoked = true, revoke_reason = trim(p_reason)
  WHERE id = p_admit_card_id AND school_id = v_school AND NOT is_revoked
  RETURNING exam_id INTO v_exam;

  IF v_exam IS NULL THEN
    RAISE EXCEPTION 'Admit card not found (or already revoked)';
  END IF;

  -- free the enrollment for regeneration: revoked card is kept only
  -- in the audit log; the row itself must yield the UNIQUE slot
  DELETE FROM public.admit_cards WHERE id = p_admit_card_id;

  PERFORM public.log_exam_audit(v_school, 'admit_card', p_admit_card_id, 'revoke',
            NULL, jsonb_build_object('exam_id', v_exam), trim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_admit_card(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_admit_card(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- record_admit_card_print - called by the PDF route after a
-- successful render. Requires the admit_cards.print permission.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_admit_card_print(p_admit_card_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_count   integer;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();
  IF NOT (v_role IN ('school_admin', 'principal')
          OR public.has_permission('admit_cards.print')) THEN
    RAISE EXCEPTION 'Access denied: admit card printing not allowed for your role';
  END IF;

  UPDATE public.admit_cards
  SET print_count = print_count + 1, last_printed_at = now()
  WHERE id = ANY (p_admit_card_ids) AND school_id = v_school;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_admit_card_print(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_admit_card_print(uuid[]) TO authenticated;

-- ------------------------------------------------------------
-- verify_admit_card - staff-side QR check (gate / exam room).
-- Returns a verdict + minimal student payload for visual match.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_admit_card(p_qr_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_row    record;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();

  SELECT ac.id, ac.is_revoked, e.name AS exam_name, e.status AS exam_status,
         s.full_name, s.photo_url, ee.roll_number, ee.seat_number, ee.status AS enroll_status,
         c.name AS class_name, c.section
  INTO v_row
  FROM public.admit_cards ac
  JOIN public.exams e            ON e.id = ac.exam_id
  JOIN public.exam_enrollments ee ON ee.id = ac.enrollment_id
  JOIN public.students s         ON s.id = ee.student_id
  JOIN public.classes c          ON c.id = ee.class_id
  WHERE ac.qr_token = p_qr_token AND ac.school_id = v_school;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'not_found');
  END IF;
  IF v_row.is_revoked THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'revoked');
  END IF;
  IF v_row.enroll_status <> 'enrolled' THEN
    RETURN jsonb_build_object('valid', false, 'reason', v_row.enroll_status);
  END IF;

  RETURN jsonb_build_object(
    'valid', true,
    'student_name', v_row.full_name,
    'photo_url', v_row.photo_url,
    'roll_number', v_row.roll_number,
    'seat_number', v_row.seat_number,
    'class_label', v_row.class_name || COALESCE('-' || v_row.section, ''),
    'exam_name', v_row.exam_name,
    'exam_status', v_row.exam_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_admit_card(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_admit_card(uuid) TO authenticated;


-- ============================================================
-- SECTION 3: LIFECYCLE STRENGTHENING (CREATE OR REPLACE upgrades
-- promised in the phase 1 migration header)
-- ============================================================

-- cancel_exam: now also revokes every live admit card (Step 8 case 2)
CREATE OR REPLACE FUNCTION public.cancel_exam(p_exam_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_exam    public.exams;
  v_revoked integer;
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

  UPDATE public.admit_cards
  SET is_revoked = true, revoke_reason = 'Exam cancelled'
  WHERE exam_id = p_exam_id AND NOT is_revoked;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  UPDATE public.exams
  SET status = 'cancelled', cancelled_at = now(), cancel_reason = trim(p_reason)
  WHERE id = p_exam_id;

  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'cancel',
            jsonb_build_object('status', v_exam.status),
            jsonb_build_object('status', 'cancelled', 'admit_cards_revoked', v_revoked),
            trim(p_reason));
END;
$$;

-- unpublish_exam: refuses once any card of the exam has been printed
-- (physical copies may exist); unprinted cards are deleted with the
-- enrollments they belong to.
CREATE OR REPLACE FUNCTION public.unpublish_exam(p_exam_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_exam    public.exams;
  v_printed integer;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status <> 'published' THEN
    RAISE EXCEPTION 'Only a published exam can be unpublished (current: %)', v_exam.status;
  END IF;

  SELECT count(*) INTO v_printed
  FROM public.admit_cards
  WHERE exam_id = p_exam_id AND print_count > 0;

  IF v_printed > 0 THEN
    RAISE EXCEPTION 'Cannot unpublish: % admit card(s) were already printed. Cancel the exam instead.', v_printed;
  END IF;

  DELETE FROM public.exam_enrollments WHERE exam_id = p_exam_id;  -- cascades to cards

  UPDATE public.exams
  SET status = 'draft', published_at = NULL
  WHERE id = p_exam_id;

  PERFORM public.log_exam_audit(v_school, 'exam', p_exam_id, 'unpublish',
            jsonb_build_object('status', 'published'),
            jsonb_build_object('status', 'draft'));
END;
$$;


-- ============================================================
-- SECTION 4: exam_enrollments read policy now includes the
-- receptionist (front-desk admit card printing needs the roster)
-- ============================================================

DROP POLICY IF EXISTS "exam_enroll_scoped_read" ON public.exam_enrollments;
CREATE POLICY "exam_enroll_scoped_read"
  ON public.exam_enrollments FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND (
      public.get_my_role() IN ('school_admin', 'principal', 'receptionist')
      OR public.teaches_in_class(class_id)
      OR public.is_class_teacher_of(class_id)
    )
  );


-- ============================================================
-- SECTION 5: PostgREST schema reload
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION exam_admit_cards
-- ============================================================
