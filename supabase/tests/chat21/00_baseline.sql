-- ============================================================
-- LOCAL PG16 VALIDATION HARNESS - SUPABASE STUBS + PROD BASELINE
-- Replicates the pieces of the production schema (chat02..chat20)
-- that chat21 builds on, plus Supabase auth/role stubs.
-- ============================================================

-- ---- Supabase roles ----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Supabase grants table/sequence access to client roles by default;
-- RLS is the isolation mechanism. Mirror that.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- ---- auth schema stub ---------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY,
  email text
);

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub',
    ''
  )::uuid
$$;

GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- ---- baseline tables (chat02 + later columns) ----------------

CREATE TABLE public.schools (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  address     text,
  phone       text,
  email       text,
  logo_url    text,
  plan        text        NOT NULL DEFAULT 'basic'
                          CHECK (plan IN ('basic', 'standard', 'premium')),
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- chat10 legacy WA columns
  wa_monthly_quota        integer NOT NULL DEFAULT 500,
  wa_messages_sent_month  integer NOT NULL DEFAULT 0,
  wa_quota_reset_date     date    NOT NULL DEFAULT date_trunc('month', now())::date,
  wa_alerts_enabled       boolean NOT NULL DEFAULT false
);

CREATE TABLE public.profiles (
  id            uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  school_id     uuid        REFERENCES public.schools(id) ON DELETE CASCADE,
  full_name     text        NOT NULL,
  role          text        NOT NULL DEFAULT 'school_admin',
  gate          text        DEFAULT 'Main Gate',
  phone         text,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- chat17 role check (chat21 replaces this with the operator version)
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN (
      'super_admin', 'school_admin', 'principal', 'teacher', 'collector',
      'receptionist', 'staff', 'guard', 'parent'
    ));

CREATE TABLE public.classes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  section    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.students (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  class_id        uuid        REFERENCES public.classes(id) ON DELETE SET NULL,
  full_name       text        NOT NULL,
  student_uid     text,                        -- pre-repo 002 migration
  date_of_birth   date,
  gender          text        CHECK (gender IN ('male', 'female', 'other')),
  aadhaar_number  text,
  address         text,
  parent_name     text,
  parent_phone    text,
  parent_email    text,
  photo_url       text,
  is_active       boolean     NOT NULL DEFAULT true,
  admission_date  date        NOT NULL DEFAULT CURRENT_DATE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  parent_phone_opted_out boolean NOT NULL DEFAULT false   -- chat10
);

CREATE TABLE public.attendance (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid        NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  student_id uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  scan_date  date        NOT NULL DEFAULT CURRENT_DATE,
  scan_time  timestamptz NOT NULL DEFAULT now(),
  entry_type text        NOT NULL DEFAULT 'entry' CHECK (entry_type IN ('entry', 'exit')),
  gate       text        NOT NULL DEFAULT 'Main Gate',
  guard_id   text,
  exam_id    uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX attendance_unique_per_day
  ON public.attendance (school_id, student_id, scan_date, entry_type);

-- ---- baseline helper functions --------------------------------

CREATE OR REPLACE FUNCTION public.get_my_school_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT school_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$;

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

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---- baseline RLS ---------------------------------------------

ALTER TABLE public.schools    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_see_own_school" ON public.schools
  FOR SELECT USING (id = public.get_my_school_id());

CREATE POLICY "users_see_own_profile" ON public.profiles
  FOR SELECT USING (id = auth.uid());

CREATE POLICY "school_sees_own_classes" ON public.classes
  FOR ALL USING (school_id = public.get_my_school_id());

CREATE POLICY "school_sees_own_students" ON public.students
  FOR ALL USING (school_id = public.get_my_school_id());

CREATE POLICY "guards_insert_own_school_attendance" ON public.attendance
  FOR INSERT WITH CHECK (
    school_id = (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid()
        AND role IN ('school_admin', 'guard')
        AND is_active = true
    )
  );

CREATE POLICY "guards_read_own_school_attendance" ON public.attendance
  FOR SELECT USING (
    school_id = (
      SELECT school_id FROM public.profiles
      WHERE id = auth.uid()
        AND role IN ('school_admin', 'guard')
        AND is_active = true
    )
  );

-- ---- seed -----------------------------------------------------

INSERT INTO public.schools (id, name, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Sunrise Public School', 'a@sunrise.example'),
  ('22222222-2222-2222-2222-222222222222', 'Moonlight Academy',     'b@moonlight.example');

INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin.a@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'guard.a@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'operator.a@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'admin.b@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'teacher.a@example.com');

INSERT INTO public.profiles (id, school_id, full_name, role) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Admin A',    'school_admin'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Guard A',    'guard'),
  ('aaaaaaaa-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'Admin B',    'school_admin'),
  ('aaaaaaaa-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'Teacher A',  'teacher');
-- Operator A is inserted AFTER chat21 runs (role 'operator' does not
-- exist yet in the chat17 CHECK) - see 20_setup.sql.

INSERT INTO public.classes (id, school_id, name, section) VALUES
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '5', 'A');

INSERT INTO public.students
  (id, school_id, class_id, full_name, student_uid,
   parent_name, parent_phone, parent_email, parent_phone_opted_out) VALUES
  -- A1 + A2: siblings sharing one parent phone (guardian dedupe backfill)
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'cccccccc-0000-0000-0000-000000000001', 'Aayush Ray', 'S1',
   'Rakesh Ray', '98765 43210', NULL, false),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'cccccccc-0000-0000-0000-000000000001', 'Aarav Ray', 'S2',
   'Rakesh Ray', '09876543210', NULL, false),
  -- A3: opted out phone; duplicate student_uid within school (external_ref must stay NULL)
  ('dddddddd-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   NULL, 'Chitra Sen', 'DUP',
   'Mala Sen', '9812345678', NULL, true),
  -- A4: email-only contact; duplicate student_uid within school
  ('dddddddd-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   NULL, 'Dev Mehta', 'DUP',
   'Nina Mehta', NULL, 'Nina.Mehta@Example.com', false),
  -- A5: no usable contact at all
  ('dddddddd-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111',
   NULL, 'Esha Verma', NULL,
   NULL, 'not-a-phone', NULL, false),
  -- A6: own guardian phone
  ('dddddddd-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111',
   NULL, 'Farhan Ali', 'S6',
   'Imran Ali', '+919800011122', NULL, false),
  -- B1: same student_uid as A1 but in school B (cross-school dup is fine)
  ('dddddddd-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222222',
   NULL, 'Bala Iyer', 'S1',
   'Hari Iyer', '9700011122', NULL, false);
