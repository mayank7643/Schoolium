-- ============================================================
-- SCHOOLIUM — PRODUCTION MIGRATION
-- Migration: 20260604000000_schoolium_initial_schema
-- Description: Full schema, RLS policies, functions, triggers
-- Architecture: Multi-tenant SaaS (school_id isolation via RLS)
-- ============================================================


-- ============================================================
-- SECTION 1: EXTENSIONS
-- ============================================================

create extension if not exists "uuid-ossp";


-- ============================================================
-- SECTION 2: TABLES
-- Dependency order: schools → profiles → classes → students → fees
-- ============================================================

-- ------------------------------------------------------------
-- schools (root tenant table)
-- ------------------------------------------------------------
create table if not exists public.schools (
  id          uuid        primary key default uuid_generate_v4(),
  name        text        not null,
  address     text,
  phone       text,
  email       text,
  logo_url    text,
  plan        text        not null default 'basic'
                          check (plan in ('basic', 'pro', 'enterprise')),
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- profiles (one per auth.user, links to a school)
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  school_id   uuid        references public.schools(id) on delete cascade,
  full_name   text        not null,
  role        text        not null default 'school_admin'
                          check (role in ('super_admin', 'school_admin', 'teacher', 'parent')),
  phone       text,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- classes
-- ------------------------------------------------------------
create table if not exists public.classes (
  id          uuid        primary key default uuid_generate_v4(),
  school_id   uuid        not null references public.schools(id) on delete cascade,
  name        text        not null,
  section     text,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- students
-- ------------------------------------------------------------
create table if not exists public.students (
  id              uuid        primary key default uuid_generate_v4(),
  school_id       uuid        not null references public.schools(id) on delete cascade,
  class_id        uuid        references public.classes(id) on delete set null,
  full_name       text        not null,
  date_of_birth   date,
  gender          text        check (gender in ('male', 'female', 'other')),
  aadhaar_number  text,
  address         text,
  parent_name     text,
  parent_phone    text,
  parent_email    text,
  photo_url       text,
  is_active       boolean     not null default true,
  admission_date  date        not null default current_date,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- fees
-- ------------------------------------------------------------
create table if not exists public.fees (
  id              uuid          primary key default uuid_generate_v4(),
  school_id       uuid          not null references public.schools(id) on delete cascade,
  student_id      uuid          not null references public.students(id) on delete cascade,
  amount          numeric(10,2) not null,
  fee_type        text          not null
                                check (fee_type in ('tuition', 'exam', 'transport', 'other')),
  due_date        date,
  paid_date       date,
  status          text          not null default 'pending'
                                check (status in ('pending', 'paid', 'overdue')),
  payment_method  text          check (payment_method in ('cash', 'upi', 'bank_transfer', 'online')),
  receipt_number  text          unique,
  notes           text,
  created_at      timestamptz   not null default now()
);


-- ============================================================
-- SECTION 3: INDEXES
-- ============================================================

create index if not exists idx_profiles_school_id   on public.profiles(school_id);
create index if not exists idx_classes_school_id    on public.classes(school_id);
create index if not exists idx_students_school_id   on public.students(school_id);
create index if not exists idx_students_class_id    on public.students(class_id);
create index if not exists idx_fees_school_id       on public.fees(school_id);
create index if not exists idx_fees_student_id      on public.fees(student_id);
create index if not exists idx_fees_status          on public.fees(status);


-- ============================================================
-- SECTION 4: HELPER FUNCTION
-- get_my_school_id() — security definer prevents RLS recursion
-- Used in RLS policies to look up the caller's school_id safely
-- ============================================================

create or replace function public.get_my_school_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select school_id
  from   public.profiles
  where  id = auth.uid()
  limit  1;
$$;


-- ============================================================
-- SECTION 5: AUTH TRIGGER FUNCTION
-- handle_new_user() — fires after every auth.users INSERT
-- Creates the initial profile row bypassing RLS (security definer)
-- on conflict do nothing guards against duplicate calls
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'User'),
    coalesce(new.raw_user_meta_data->>'role', 'school_admin')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


-- ============================================================
-- SECTION 6: TRIGGER
-- Drop first so recreating is idempotent
-- ============================================================

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();


-- ============================================================
-- SECTION 7: SIGNUP HELPER FUNCTION
-- create_school_for_user() — called from signup page via rpc()
-- Creates school + links profile in one atomic transaction
-- security definer bypasses RLS so no policy is needed on INSERT
-- ============================================================

create or replace function public.create_school_for_user(
  school_name  text,
  school_email text,
  school_phone text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_school_id uuid;
begin
  -- Insert the school
  insert into public.schools (name, email, phone, plan)
  values (school_name, school_email, school_phone, 'basic')
  returning id into new_school_id;

  -- Link the calling user's profile to the new school
  update public.profiles
  set
    school_id = new_school_id,
    phone     = school_phone
  where id = auth.uid();

  return new_school_id;
end;
$$;


-- ============================================================
-- SECTION 8: ROW LEVEL SECURITY — ENABLE
-- ============================================================

alter table public.schools  enable row level security;
alter table public.profiles enable row level security;
alter table public.classes  enable row level security;
alter table public.students enable row level security;
alter table public.fees     enable row level security;


-- ============================================================
-- SECTION 9: RLS POLICIES
-- Drop all known policy names before recreating (idempotent)
-- ============================================================

-- ------------------------------------------------------------
-- Drop all obsolete + superseded policies (every version seen)
-- ------------------------------------------------------------

-- schools
drop policy if exists "school_admins_see_own_school"        on public.schools;
drop policy if exists "super_admin_sees_all_schools"        on public.schools;
drop policy if exists "authenticated_can_create_school"     on public.schools;
drop policy if exists "anyone_can_create_school"            on public.schools;
drop policy if exists "users_see_own_school"                on public.schools;
drop policy if exists "users_update_own_school"             on public.schools;

-- profiles
drop policy if exists "users_see_own_profile"               on public.profiles;
drop policy if exists "school_admin_sees_school_profiles"   on public.profiles;
drop policy if exists "school_admin_manages_profiles"       on public.profiles;
drop policy if exists "super_admin_manages_profiles"        on public.profiles;
drop policy if exists "allow_insert_on_signup"              on public.profiles;
drop policy if exists "school_members_see_each_other"       on public.profiles;
drop policy if exists "users_update_own_profile"            on public.profiles;

-- classes
drop policy if exists "school_sees_own_classes"             on public.classes;
drop policy if exists "super_admin_sees_all_classes"        on public.classes;

-- students
drop policy if exists "school_sees_own_students"            on public.students;
drop policy if exists "super_admin_sees_all_students"       on public.students;

-- fees
drop policy if exists "school_sees_own_fees"                on public.fees;
drop policy if exists "super_admin_sees_all_fees"           on public.fees;


-- ------------------------------------------------------------
-- SCHOOLS — final policies
-- INSERT is handled by create_school_for_user() (security definer)
-- No INSERT policy needed or safe to add
-- ------------------------------------------------------------

create policy "users_see_own_school"
  on public.schools for select
  using ( id = public.get_my_school_id() );

create policy "users_update_own_school"
  on public.schools for update
  using ( id = public.get_my_school_id() );


-- ------------------------------------------------------------
-- PROFILES — final policies
-- INSERT is handled by handle_new_user trigger (security definer)
-- No INSERT policy needed
-- ------------------------------------------------------------

create policy "users_see_own_profile"
  on public.profiles for select
  using ( id = auth.uid() );

create policy "users_update_own_profile"
  on public.profiles for update
  using ( id = auth.uid() );


-- ------------------------------------------------------------
-- CLASSES — school_id isolation
-- ------------------------------------------------------------

create policy "school_sees_own_classes"
  on public.classes for all
  using ( school_id = public.get_my_school_id() );


-- ------------------------------------------------------------
-- STUDENTS — school_id isolation
-- ------------------------------------------------------------

create policy "school_sees_own_students"
  on public.students for all
  using ( school_id = public.get_my_school_id() );


-- ------------------------------------------------------------
-- FEES — school_id isolation
-- ------------------------------------------------------------

create policy "school_sees_own_fees"
  on public.fees for all
  using ( school_id = public.get_my_school_id() );


-- ============================================================
-- SECTION 10: SEED DATA
-- Schoolium super-admin school (fixed UUID for reference)
-- ============================================================

insert into public.schools (id, name, email, plan)
values (
  '00000000-0000-0000-0000-000000000001',
  'Schoolium HQ',
  'admin@schoolium.app',
  'enterprise'
)
on conflict (id) do nothing;


-- ============================================================
-- END OF MIGRATION
-- ============================================================
