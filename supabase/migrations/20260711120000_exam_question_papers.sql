-- ============================================================
-- SCHOOLIUM - EXAM MODULE PHASE 4 - exam_question_papers
-- Design: docs/exam-module/ Steps 2-5 (Group C, question papers).
-- Assumes: exam_sessions_core + exam_logistics + exam_admit_cards.
-- ============================================================
-- Contents:
--   SECTION 1  question_papers, question_paper_versions,
--              question_paper_access_logs + RLS
--   SECTION 2  storage bucket question-papers + object policies
--              (uploads only against an RPC-registered version row;
--              teachers have NO direct read - downloads go through
--              the logging RPC + short-lived signed URLs)
--   SECTION 3  RPCs: register_question_paper_upload,
--              lock/unlock_question_paper,
--              authorize_question_paper_access (the download gate)
--   SECTION 4  PostgREST schema reload
-- Idempotent throughout. Pure ASCII.
-- ============================================================


-- ============================================================
-- SECTION 1: TABLES + RLS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.question_papers (
  id                  uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id           uuid        NOT NULL REFERENCES public.schools(id)        ON DELETE CASCADE,
  exam_subject_id     uuid        NOT NULL REFERENCES public.exam_subjects(id)  ON DELETE CASCADE,
  status              text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  current_version_id  uuid,
  locked_by           uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  locked_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_question_papers_paper UNIQUE (exam_subject_id)
);

CREATE TABLE IF NOT EXISTS public.question_paper_versions (
  id                 uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id          uuid        NOT NULL REFERENCES public.schools(id)          ON DELETE CASCADE,
  question_paper_id  uuid        NOT NULL REFERENCES public.question_papers(id)  ON DELETE CASCADE,
  version_no         integer     NOT NULL,
  file_path          text        NOT NULL,
  file_size          integer,
  note               text,
  uploaded_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_qp_versions UNIQUE (question_paper_id, version_no),
  CONSTRAINT uq_qp_version_path UNIQUE (file_path)
);

-- deferrable circular FK (docs Step 3 section 3.5)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_qp_current_version'
  ) THEN
    ALTER TABLE public.question_papers
      ADD CONSTRAINT fk_qp_current_version
      FOREIGN KEY (current_version_id) REFERENCES public.question_paper_versions(id)
      ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.question_paper_access_logs (
  id                 uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id          uuid        NOT NULL REFERENCES public.schools(id)          ON DELETE CASCADE,
  question_paper_id  uuid        NOT NULL REFERENCES public.question_papers(id)  ON DELETE CASCADE,
  version_id         uuid        REFERENCES public.question_paper_versions(id)   ON DELETE SET NULL,
  profile_id         uuid        REFERENCES public.profiles(id)                  ON DELETE SET NULL,
  action             text        NOT NULL CHECK (action IN ('upload','download','lock','unlock')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.question_paper_access_logs IS
  'Append-only. Every download goes through authorize_question_paper_access '
  'which inserts here BEFORE returning the file path - an unlogged teacher '
  'download is structurally impossible (teachers have no storage SELECT).';

CREATE INDEX IF NOT EXISTS idx_qp_school        ON public.question_papers(school_id);
CREATE INDEX IF NOT EXISTS idx_qp_versions_qp   ON public.question_paper_versions(question_paper_id, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_qp_versions_school ON public.question_paper_versions(school_id);
CREATE INDEX IF NOT EXISTS idx_qp_logs_qp       ON public.question_paper_access_logs(question_paper_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qp_logs_school   ON public.question_paper_access_logs(school_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_qp_updated_at ON public.question_papers;
CREATE TRIGGER trg_qp_updated_at
  BEFORE UPDATE ON public.question_papers
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.question_papers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_paper_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_paper_access_logs ENABLE ROW LEVEL SECURITY;

-- helper: does the caller teach the paper behind this question paper?
CREATE OR REPLACE FUNCTION public.can_access_question_paper(p_exam_subject_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.exam_subjects es
    WHERE es.id = p_exam_subject_id
      AND es.school_id = public.get_my_school_id()
      AND (
        public.get_my_role() IN ('school_admin', 'principal')
        OR public.teaches_subject_in_class(es.subject_id, es.class_id)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.can_access_question_paper(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_question_paper(uuid) TO authenticated;

DROP POLICY IF EXISTS "qp_scoped_read" ON public.question_papers;
CREATE POLICY "qp_scoped_read"
  ON public.question_papers FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.can_access_question_paper(exam_subject_id)
  );

DROP POLICY IF EXISTS "qp_versions_scoped_read" ON public.question_paper_versions;
CREATE POLICY "qp_versions_scoped_read"
  ON public.question_paper_versions FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND EXISTS (
      SELECT 1 FROM public.question_papers qp
      WHERE qp.id = question_paper_id
        AND public.can_access_question_paper(qp.exam_subject_id)
    )
  );

-- access logs: admin/principal only (teachers do not see who accessed)
DROP POLICY IF EXISTS "qp_logs_admin_read" ON public.question_paper_access_logs;
CREATE POLICY "qp_logs_admin_read"
  ON public.question_paper_access_logs FOR SELECT
  USING (
    school_id = public.get_my_school_id()
    AND public.get_my_role() IN ('school_admin', 'principal')
  );


-- ============================================================
-- SECTION 2: STORAGE - private question-papers bucket
-- Path convention: {school_id}/{exam_id}/{exam_subject_id}/v{N}.pdf
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('question-papers', 'question-papers', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
SET file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Admin / principal: full access within their school's folder
DROP POLICY IF EXISTS "qp_storage_admin_manage" ON storage.objects;
CREATE POLICY "qp_storage_admin_manage" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'question-papers'
    AND (storage.foldername(name))[1] = public.get_my_school_id()::text
    AND public.get_my_role() IN ('school_admin', 'principal')
  )
  WITH CHECK (
    bucket_id = 'question-papers'
    AND (storage.foldername(name))[1] = public.get_my_school_id()::text
    AND public.get_my_role() IN ('school_admin', 'principal')
  );

-- Uploader: may INSERT/UPDATE ONLY an object whose exact path was
-- registered to them by register_question_paper_upload. No SELECT
-- policy for teachers - reads go through signed URLs only.
DROP POLICY IF EXISTS "qp_storage_registered_upload" ON storage.objects;
CREATE POLICY "qp_storage_registered_upload" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'question-papers'
    AND (storage.foldername(name))[1] = public.get_my_school_id()::text
    AND EXISTS (
      SELECT 1 FROM public.question_paper_versions v
      WHERE v.file_path = name AND v.uploaded_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS "qp_storage_registered_reupload" ON storage.objects;
CREATE POLICY "qp_storage_registered_reupload" ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'question-papers'
    AND (storage.foldername(name))[1] = public.get_my_school_id()::text
    AND EXISTS (
      SELECT 1 FROM public.question_paper_versions v
      WHERE v.file_path = name AND v.uploaded_by = auth.uid()
    )
  )
  WITH CHECK (
    bucket_id = 'question-papers'
    AND (storage.foldername(name))[1] = public.get_my_school_id()::text
    AND EXISTS (
      SELECT 1 FROM public.question_paper_versions v
      WHERE v.file_path = name AND v.uploaded_by = auth.uid()
    )
  );


-- ============================================================
-- SECTION 3: RPCs
-- ============================================================

-- ------------------------------------------------------------
-- register_question_paper_upload - the ONLY way a version row
-- (and thus an uploadable storage path) comes into existence.
-- Returns the path the client must upload the PDF to.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_question_paper_upload(
  p_exam_subject_id uuid,
  p_file_size       integer DEFAULT NULL,
  p_note            text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_paper   record;
  v_qp      public.question_papers;
  v_next    integer;
  v_path    text;
  v_version uuid;
  v_today   date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();

  SELECT es.id, es.exam_id, es.subject_id, es.class_id, es.is_cancelled,
         es.exam_date, e.status AS exam_status
  INTO v_paper
  FROM public.exam_subjects es
  JOIN public.exams e ON e.id = es.exam_id
  WHERE es.id = p_exam_subject_id AND es.school_id = v_school;

  IF v_paper.id IS NULL THEN
    RAISE EXCEPTION 'Paper not found';
  END IF;
  IF NOT (v_role IN ('school_admin', 'principal')
          OR public.teaches_subject_in_class(v_paper.subject_id, v_paper.class_id)) THEN
    RAISE EXCEPTION 'Access denied: you are not assigned to this subject and class';
  END IF;
  IF v_paper.is_cancelled THEN
    RAISE EXCEPTION 'This paper is cancelled';
  END IF;
  IF v_paper.exam_status NOT IN ('draft', 'published', 'ongoing') THEN
    RAISE EXCEPTION 'Uploads are closed - the exam is %', v_paper.exam_status;
  END IF;
  IF v_paper.exam_status = 'ongoing'
     AND v_paper.exam_date IS NOT NULL AND v_paper.exam_date < v_today THEN
    RAISE EXCEPTION 'Uploads are closed - this paper''s exam date has passed';
  END IF;

  -- get or create the question_papers row, locked
  SELECT * INTO v_qp FROM public.question_papers
  WHERE exam_subject_id = p_exam_subject_id
  FOR UPDATE;

  IF v_qp.id IS NULL THEN
    INSERT INTO public.question_papers (school_id, exam_subject_id)
    VALUES (v_school, p_exam_subject_id)
    RETURNING * INTO v_qp;
  END IF;

  IF v_qp.status = 'final' THEN
    RAISE EXCEPTION 'The question paper is locked (final) - ask the principal to unlock it first';
  END IF;

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_next
  FROM public.question_paper_versions
  WHERE question_paper_id = v_qp.id;

  v_path := v_school::text || '/' || v_paper.exam_id::text || '/'
            || p_exam_subject_id::text || '/v' || v_next::text || '.pdf';

  INSERT INTO public.question_paper_versions
    (school_id, question_paper_id, version_no, file_path, file_size, note, uploaded_by)
  VALUES
    (v_school, v_qp.id, v_next, v_path, p_file_size, p_note, auth.uid())
  RETURNING id INTO v_version;

  UPDATE public.question_papers
  SET current_version_id = v_version
  WHERE id = v_qp.id;

  INSERT INTO public.question_paper_access_logs
    (school_id, question_paper_id, version_id, profile_id, action)
  VALUES (v_school, v_qp.id, v_version, auth.uid(), 'upload');

  RETURN jsonb_build_object(
    'question_paper_id', v_qp.id,
    'version_id', v_version,
    'version_no', v_next,
    'file_path', v_path
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_question_paper_upload(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_question_paper_upload(uuid, integer, text) TO authenticated;

-- ------------------------------------------------------------
-- lock_question_paper / unlock_question_paper
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_question_paper(p_question_paper_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_qp     public.question_papers;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();

  SELECT * INTO v_qp FROM public.question_papers
  WHERE id = p_question_paper_id AND school_id = v_school
  FOR UPDATE;

  IF v_qp.id IS NULL THEN
    RAISE EXCEPTION 'Question paper not found';
  END IF;
  IF v_qp.status = 'final' THEN
    RETURN;  -- idempotent
  END IF;
  IF v_qp.current_version_id IS NULL THEN
    RAISE EXCEPTION 'Nothing to lock - no version uploaded yet';
  END IF;

  UPDATE public.question_papers
  SET status = 'final', locked_by = auth.uid(), locked_at = now()
  WHERE id = p_question_paper_id;

  INSERT INTO public.question_paper_access_logs
    (school_id, question_paper_id, version_id, profile_id, action)
  VALUES (v_school, p_question_paper_id, v_qp.current_version_id, auth.uid(), 'lock');
END;
$$;

REVOKE ALL ON FUNCTION public.lock_question_paper(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_question_paper(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.unlock_question_paper(p_question_paper_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_school uuid;
  v_qp     public.question_papers;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_admin();
  IF v_role <> 'school_admin' THEN
    RAISE EXCEPTION 'Access denied: only the school admin can unlock a final question paper';
  END IF;
  IF length(COALESCE(trim(p_reason), '')) < 10 THEN
    RAISE EXCEPTION 'A reason (at least 10 characters) is required to unlock';
  END IF;

  SELECT * INTO v_qp FROM public.question_papers
  WHERE id = p_question_paper_id AND school_id = v_school
  FOR UPDATE;

  IF v_qp.id IS NULL THEN
    RAISE EXCEPTION 'Question paper not found';
  END IF;
  IF v_qp.status <> 'final' THEN
    RETURN;  -- idempotent
  END IF;

  UPDATE public.question_papers
  SET status = 'draft', locked_by = NULL, locked_at = NULL
  WHERE id = p_question_paper_id;

  INSERT INTO public.question_paper_access_logs
    (school_id, question_paper_id, version_id, profile_id, action)
  VALUES (v_school, p_question_paper_id, v_qp.current_version_id, auth.uid(), 'unlock');

  PERFORM public.log_exam_audit(v_school, 'question_paper', p_question_paper_id,
            'unlock', NULL, NULL, trim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_question_paper(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unlock_question_paper(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- authorize_question_paper_access - the download gate. Validates
-- the caller, INSERTS the log row, then returns the storage path.
-- The API route exchanges the path for a 60-second signed URL.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.authorize_question_paper_access(
  p_question_paper_id uuid,
  p_version_id        uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_school  uuid;
  v_qp      record;
  v_version record;
BEGIN
  SELECT * INTO v_role, v_school FROM public.exam_ctx_staff();

  SELECT qp.id, qp.exam_subject_id, qp.current_version_id
  INTO v_qp
  FROM public.question_papers qp
  WHERE qp.id = p_question_paper_id AND qp.school_id = v_school;

  IF v_qp.id IS NULL THEN
    RAISE EXCEPTION 'Question paper not found';
  END IF;
  IF NOT public.can_access_question_paper(v_qp.exam_subject_id) THEN
    RAISE EXCEPTION 'Access denied: you are not assigned to this subject and class';
  END IF;

  SELECT v.id, v.file_path INTO v_version
  FROM public.question_paper_versions v
  WHERE v.id = COALESCE(p_version_id, v_qp.current_version_id)
    AND v.question_paper_id = v_qp.id;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'Version not found';
  END IF;

  INSERT INTO public.question_paper_access_logs
    (school_id, question_paper_id, version_id, profile_id, action)
  VALUES (v_school, v_qp.id, v_version.id, auth.uid(), 'download');

  RETURN v_version.file_path;
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_question_paper_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_question_paper_access(uuid, uuid) TO authenticated;


-- ============================================================
-- SECTION 4: PostgREST schema reload
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION exam_question_papers
-- ============================================================
