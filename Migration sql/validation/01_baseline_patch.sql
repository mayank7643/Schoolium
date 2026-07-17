-- Baseline patch for the local validation harness (NOT part of the app).
-- Adds columns that production migrations BETWEEN chat02 and chat17 create
-- but which this harness does not replay (it only loads chat02 + chat17).
-- Run AFTER chat02 and chat17, BEFORE the exam-module migrations.
\set ON_ERROR_STOP on

-- student_uid: production "002_student_uid_and_fees" adds it; the exam
-- module reads it for admit cards and report cards.
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS student_uid text;
-- parent_phone_opted_out: fee/WhatsApp module column; exam result
-- notification targets respect it.
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS parent_phone_opted_out boolean NOT NULL DEFAULT false;

-- auth_rate_limit: chat19 creates it; the exam public endpoints reuse it
-- for rate limiting (Phase 8).
CREATE TABLE IF NOT EXISTS public.auth_rate_limit (
  id          bigserial   PRIMARY KEY,
  bucket      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
