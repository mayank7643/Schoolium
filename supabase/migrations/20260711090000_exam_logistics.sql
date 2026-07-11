-- ============================================================
-- SCHOOLIUM - EXAM MODULE PHASE 2 - exam_logistics
-- Design: docs/exam-module/ Steps 2-4 (Group C).
-- Assumes: chat02..chat20 + 20260708120000_exam_sessions_core.
-- Independent of the alerts migration (chat21_alerts_byog) - the
-- two touch disjoint objects and can run in any order.
-- ============================================================
-- Contents:
--   SECTION 1  holidays table + indexes + trigger + RLS
--   SECTION 2  auto_generate_timetable RPC
--   SECTION 3  validate_exam_timetable v2 (adds HOLIDAY_CLASH,
--              ROOM_DOUBLE_BOOKED, ROOM_OVERFLOW)
--   SECTION 4  PostgREST schema reload
-- Idempotent throughout. Pure ASCII.
-- ============================================================


-- ============================================================
-- SECTION 1: holidays
-- ============================================================

CREATE TABLE IF NOT EXISTS public.holidays (
  id            uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id     uuid        NOT NULL REFERENCES public.schools(id)           ON DELETE CASCADE,
  session_id    uuid        NOT NULL REFERENCES public.academic_sessions(id) ON DELETE CASCADE,
  holiday_date  date        NOT NULL,
  name          text        NOT NULL,
  created_by    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_holidays_date UNIQUE (school_id, holiday_date)
);

COMMENT ON TABLE public.holidays IS
  'School holiday calendar. Consumed by exam timetable auto-generation '
  'and the timetable validator (HOLIDAY_CLASH).';

CREATE INDEX IF NOT EXISTS idx_holidays_school_date ON public.holidays(school_id, holiday_date);
CREATE INDEX IF NOT EXISTS idx_holidays_session     ON public.holidays(session_id);

CREATE OR REPLACE FUNCTION public.tg_ck_holiday_school()
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

DROP TRIGGER IF EXISTS trg_ck_holiday_school ON public.holidays;
CREATE TRIGGER trg_ck_holiday_school
  BEFORE INSERT OR UPDATE ON public.holidays
  FOR EACH ROW EXECUTE FUNCTION public.tg_ck_holiday_school();

ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "holidays_school_read" ON public.holidays;
CREATE POLICY "holidays_school_read"
  ON public.holidays FOR SELECT
  USING ( school_id = public.get_my_school_id() );

DROP POLICY IF EXISTS "holidays_admin_write" ON public.holidays;
CREATE POLICY "holidays_admin_write"
  ON public.holidays FOR ALL
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );


-- ============================================================
-- SECTION 2: auto_generate_timetable
-- Fills exam_date/start_time/duration for unscheduled papers
-- (or all papers with p_overwrite). Skips Sundays (optional) and
-- holidays; one paper per class per day; p_gap_days rest days
-- between consecutive papers of one class. Classes share dates.
-- Existing manual entries are respected unless p_overwrite.
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_generate_timetable(
  p_exam_id          uuid,
  p_start_date       date,
  p_end_date         date,
  p_gap_days         integer DEFAULT 0,
  p_default_start    time    DEFAULT '10:00',
  p_default_duration integer DEFAULT 180,
  p_overwrite        boolean DEFAULT false,
  p_skip_sundays     boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        text;
  v_school      uuid;
  v_exam        public.exams;
  v_days        date[];
  v_busy        date[];
  v_class       uuid;
  v_paper       uuid;
  v_idx         integer;
  v_len         integer;
  v_scheduled   integer := 0;
  v_unscheduled integer := 0;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  v_exam := public.lock_exam_row(p_exam_id, v_school);

  IF v_exam.status NOT IN ('draft', 'published') THEN
    RAISE EXCEPTION 'The timetable can only be generated while the exam is draft or published (current: %)', v_exam.status;
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date THEN
    RAISE EXCEPTION 'Invalid date window';
  END IF;
  IF p_end_date - p_start_date > 120 THEN
    RAISE EXCEPTION 'Window too large - maximum 120 days';
  END IF;
  IF p_gap_days IS NULL OR p_gap_days < 0 OR p_gap_days > 30 THEN
    RAISE EXCEPTION 'Gap days must be between 0 and 30';
  END IF;
  IF p_default_duration IS NULL OR p_default_duration <= 0 THEN
    RAISE EXCEPTION 'Default duration must be positive';
  END IF;

  -- candidate days: window minus Sundays minus holidays
  SELECT array_agg(d.day ORDER BY d.day) INTO v_days
  FROM (
    SELECT gs::date AS day
    FROM generate_series(p_start_date, p_end_date, interval '1 day') gs
  ) d
  WHERE (NOT p_skip_sundays OR extract(dow FROM d.day) <> 0)
    AND NOT EXISTS (
      SELECT 1 FROM public.holidays h
      WHERE h.school_id = v_school AND h.holiday_date = d.day
    );

  v_len := COALESCE(array_length(v_days, 1), 0);
  IF v_len = 0 THEN
    RAISE EXCEPTION 'No usable days in the window (all Sundays or holidays)';
  END IF;

  FOR v_class IN
    SELECT ec.class_id FROM public.exam_classes ec WHERE ec.exam_id = p_exam_id
  LOOP
    -- days already taken by this class (kept when not overwriting)
    IF p_overwrite THEN
      v_busy := ARRAY[]::date[];
    ELSE
      SELECT COALESCE(array_agg(es.exam_date), ARRAY[]::date[]) INTO v_busy
      FROM public.exam_subjects es
      WHERE es.exam_id = p_exam_id
        AND es.class_id = v_class
        AND es.exam_date IS NOT NULL
        AND NOT es.is_cancelled;
    END IF;

    v_idx := 1;

    FOR v_paper IN
      SELECT es.id
      FROM public.exam_subjects es
      JOIN public.subjects sub ON sub.id = es.subject_id
      WHERE es.exam_id = p_exam_id
        AND es.class_id = v_class
        AND NOT es.is_cancelled
        AND (p_overwrite OR es.exam_date IS NULL)
      ORDER BY sub.name, es.id
    LOOP
      -- advance past days the class is already sitting a paper on
      WHILE v_idx <= v_len AND v_days[v_idx] = ANY (v_busy) LOOP
        v_idx := v_idx + 1;
      END LOOP;

      IF v_idx > v_len THEN
        v_unscheduled := v_unscheduled + 1;
        CONTINUE;
      END IF;

      UPDATE public.exam_subjects
      SET exam_date        = v_days[v_idx],
          start_time       = CASE WHEN p_overwrite OR start_time IS NULL THEN p_default_start ELSE start_time END,
          duration_minutes = CASE WHEN p_overwrite OR duration_minutes IS NULL THEN p_default_duration ELSE duration_minutes END,
          reporting_time   = CASE WHEN p_overwrite OR reporting_time IS NULL
                                  THEN (p_default_start - interval '30 minutes')::time
                                  ELSE reporting_time END
      WHERE id = v_paper;

      v_scheduled := v_scheduled + 1;
      v_idx := v_idx + 1 + p_gap_days;
    END LOOP;
  END LOOP;

  PERFORM public.log_exam_audit(v_school, 'timetable', p_exam_id, 'auto_generate',
            NULL, jsonb_build_object('scheduled', v_scheduled, 'unscheduled', v_unscheduled,
                                     'window_start', p_start_date, 'window_end', p_end_date,
                                     'overwrite', p_overwrite));

  RETURN jsonb_build_object('scheduled', v_scheduled, 'unscheduled', v_unscheduled);
END;
$$;

REVOKE ALL ON FUNCTION public.auto_generate_timetable(uuid, date, date, integer, time, integer, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_generate_timetable(uuid, date, date, integer, time, integer, boolean, boolean) TO authenticated;


-- ============================================================
-- SECTION 3: validate_exam_timetable v2
-- Adds to v1 (MISSING_SCHEDULE, CLASS_OVERLAP, SAME_DAY_LOAD):
--   HOLIDAY_CLASH      error    paper dated on a school holiday
--   ROOM_DOUBLE_BOOKED warning  same room, overlapping slot,
--                               school-wide across live exams
--   ROOM_OVERFLOW      warning  enrolled students exceed capacity
-- Same signature - CREATE OR REPLACE upgrade, callers unchanged.
-- ============================================================

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
  -- HOLIDAY_CLASH
  SELECT 'error'::text, 'HOLIDAY_CLASH'::text, es.id,
         (c.name || COALESCE('-' || c.section, ''))::text, sub.name,
         (sub.name || ' (' || c.name || COALESCE('-' || c.section, '') || ') falls on '
          || h.name || ' (' || to_char(h.holiday_date, 'DD Mon') || ')')::text
  FROM public.exam_subjects es
  JOIN public.holidays h   ON h.school_id = es.school_id AND h.holiday_date = es.exam_date
  JOIN public.classes  c   ON c.id = es.class_id
  JOIN public.subjects sub ON sub.id = es.subject_id
  WHERE es.exam_id = p_exam_id
    AND NOT es.is_cancelled

  UNION ALL
  -- CLASS_OVERLAP
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
  -- ROOM_DOUBLE_BOOKED: school-wide across draft/published/ongoing exams
  SELECT 'warning'::text, 'ROOM_DOUBLE_BOOKED'::text, a.id,
         (c.name || COALESCE('-' || c.section, ''))::text, sa.name,
         ('Room ' || r.name || ': ' || sa.name || ' (' || c.name || COALESCE('-' || c.section, '')
          || ') overlaps ' || sb.name || ' (' || cb.name || COALESCE('-' || cb.section, '')
          || CASE WHEN b.exam_id <> a.exam_id THEN ', exam: ' || eb.name ELSE '' END
          || ') on ' || to_char(a.exam_date, 'DD Mon'))::text
  FROM public.exam_subjects a
  JOIN public.exam_subjects b
    ON b.room_id = a.room_id
   AND b.exam_date = a.exam_date
   AND b.id <> a.id
   AND NOT (b.exam_id = a.exam_id AND b.id < a.id)  -- report intra-exam pairs once
   AND NOT b.is_cancelled
   AND b.start_time IS NOT NULL AND b.duration_minutes IS NOT NULL
  JOIN public.exams eb ON eb.id = b.exam_id AND eb.status IN ('draft', 'published', 'ongoing')
  JOIN public.exam_rooms r ON r.id = a.room_id
  JOIN public.classes  c   ON c.id = a.class_id
  JOIN public.classes  cb  ON cb.id = b.class_id
  JOIN public.subjects sa  ON sa.id = a.subject_id
  JOIN public.subjects sb  ON sb.id = b.subject_id
  WHERE a.exam_id = p_exam_id
    AND a.room_id IS NOT NULL
    AND NOT a.is_cancelled
    AND a.start_time IS NOT NULL AND a.duration_minutes IS NOT NULL
    AND (a.exam_date + a.start_time,
         a.exam_date + a.start_time + make_interval(mins => a.duration_minutes))
        OVERLAPS
        (b.exam_date + b.start_time,
         b.exam_date + b.start_time + make_interval(mins => b.duration_minutes))

  UNION ALL
  -- ROOM_OVERFLOW: enrolled headcount vs room capacity (per paper)
  SELECT 'warning'::text, 'ROOM_OVERFLOW'::text, es.id,
         (c.name || COALESCE('-' || c.section, ''))::text, sub.name,
         ('Room ' || r.name || ' holds ' || r.capacity || ' but ' || cnt.n
          || ' student(s) of ' || c.name || COALESCE('-' || c.section, '')
          || ' sit ' || sub.name)::text
  FROM public.exam_subjects es
  JOIN public.exam_rooms r ON r.id = es.room_id AND r.capacity IS NOT NULL
  JOIN public.classes  c   ON c.id = es.class_id
  JOIN public.subjects sub ON sub.id = es.subject_id
  JOIN LATERAL (
    SELECT count(*)::integer AS n
    FROM public.exam_enrollments ee
    WHERE ee.exam_id = es.exam_id
      AND ee.class_id = es.class_id
      AND ee.status = 'enrolled'
  ) cnt ON cnt.n > r.capacity
  WHERE es.exam_id = p_exam_id
    AND NOT es.is_cancelled

  UNION ALL
  -- SAME_DAY_LOAD
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


-- ============================================================
-- SECTION 4: PostgREST schema reload
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION exam_logistics
-- ============================================================
