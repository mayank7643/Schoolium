-- ============================================================
-- FUNCTIONAL + EXPLOIT TESTS - chat22 managed mode
-- Runs after chat21's harness files (00,10,20) + chat22 migration.
-- School A from 20_setup.sql already has alerts enabled and approved
-- whatsapp/email channel templates.
-- ============================================================

\set ON_ERROR_STOP on

-- ---- M1: mode helper defaults to byog ---------------------------
DO $$
BEGIN
  IF public.alerts_channel_mode('11111111-1111-1111-1111-111111111111', 'whatsapp') <> 'byog' THEN
    RAISE EXCEPTION 'M1a default mode not byog';
  END IF;
END $$;

-- ---- M2: mode-aware pricing -------------------------------------
DO $$
BEGIN
  -- whatsapp utility: byog 12p +18% = 14 ; managed 30p +18% = 35
  IF public.alerts_message_cost('whatsapp', 'utility', 'byog') <> 14 THEN RAISE EXCEPTION 'M2a byog cost'; END IF;
  IF public.alerts_message_cost('whatsapp', 'utility', 'managed') <> 35 THEN RAISE EXCEPTION 'M2b managed cost'; END IF;
  -- default arg = byog (send_test_message path)
  IF public.alerts_message_cost('whatsapp', 'utility') <> 14 THEN RAISE EXCEPTION 'M2c default arg'; END IF;
  -- email managed is priced (10p +18% = 12), byog free
  IF public.alerts_message_cost('email', 'service', 'byog') <> 0 THEN RAISE EXCEPTION 'M2d email byog'; END IF;
  IF public.alerts_message_cost('email', 'service', 'managed') <> 12 THEN RAISE EXCEPTION 'M2e email managed'; END IF;
END $$;

-- ---- M3: managed mode stamps outbox + prices at managed rate -----
-- Switch school A whatsapp to managed, scan a student, check the row.
INSERT INTO public.channel_modes (school_id, channel, mode)
VALUES ('11111111-1111-1111-1111-111111111111', 'whatsapp', 'managed')
ON CONFLICT (school_id, channel) DO UPDATE SET mode = 'managed';

-- Reset spend so the cap is not in the way from earlier harness runs.
UPDATE public.spend_guard
SET    daily_cap_paise = 500000, spent_today_paise = 0, spent_date = current_date
WHERE  school_id = '11111111-1111-1111-1111-111111111111';

SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}', false);
SET ROLE authenticated;
INSERT INTO public.attendance (school_id, student_id, scan_date, entry_type, guard_id)
VALUES ('11111111-1111-1111-1111-111111111111',
        'dddddddd-0000-0000-0000-000000000006',   -- Farhan, own phone, not yet checked in today
        (now() AT TIME ZONE 'Asia/Kolkata')::date, 'entry',
        'aaaaaaaa-0000-0000-0000-000000000002');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);

DO $$
DECLARE m public.message_outbox%ROWTYPE;
BEGIN
  SELECT mo.* INTO m
  FROM   public.message_outbox mo
  JOIN   public.events ev ON ev.id = mo.event_id
  WHERE  ev.subject_id = 'dddddddd-0000-0000-0000-000000000006'
    AND  ev.type = 'student.checked_in';
  IF NOT FOUND THEN RAISE EXCEPTION 'M3a no outbox row'; END IF;
  IF m.channel <> 'whatsapp' THEN RAISE EXCEPTION 'M3b channel'; END IF;
  IF m.mode <> 'managed' THEN RAISE EXCEPTION 'M3c mode not stamped managed: %', m.mode; END IF;
  IF m.cost_estimate_paise <> 35 THEN RAISE EXCEPTION 'M3d managed price, got %', m.cost_estimate_paise; END IF;
END $$;

-- ---- M4: email renders subject + body text ----------------------
-- Point school A's notice at email-managed and publish.
INSERT INTO public.channel_modes (school_id, channel, mode)
VALUES ('11111111-1111-1111-1111-111111111111', 'email', 'managed')
ON CONFLICT (school_id, channel) DO UPDATE SET mode = 'managed';

UPDATE public.channel_templates
SET    email_subject = '{{school}} notice for {{date}}'
WHERE  school_id = '11111111-1111-1111-1111-111111111111'
  AND  channel = 'email';

DO $$
DECLARE
  v_mt uuid;
  eid  bigint;
  res  jsonb;
  m    public.message_outbox%ROWTYPE;
BEGIN
  PERFORM set_config('request.jwt.claims',
                     '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}', false);
  SELECT mt.id INTO v_mt FROM public.message_templates mt
  WHERE  mt.school_id = '11111111-1111-1111-1111-111111111111' AND mt.key = 'notice';

  res := public.publish_notice(v_mt, '{"message":"Sports day Saturday"}'::jsonb, NULL);
  eid := (res ->> 'event_id')::bigint;

  -- The email-only guardian (Dev Mehta's parent) gets an email row.
  SELECT mo.* INTO m
  FROM   public.message_outbox mo
  WHERE  mo.event_id = eid AND mo.channel = 'email'
  LIMIT  1;
  IF NOT FOUND THEN RAISE EXCEPTION 'M4a no email row'; END IF;
  IF m.mode <> 'managed' THEN RAISE EXCEPTION 'M4b email mode'; END IF;
  IF m.vars ->> 'subject' NOT LIKE 'Sunrise Public School notice for %' THEN
    RAISE EXCEPTION 'M4c subject: %', m.vars ->> 'subject';
  END IF;
  IF m.vars ->> 'text' NOT LIKE '%Sports day Saturday%' THEN
    RAISE EXCEPTION 'M4d body text: %', m.vars ->> 'text';
  END IF;
  IF m.cost_estimate_paise <> 12 THEN RAISE EXCEPTION 'M4e email managed cost, got %', m.cost_estimate_paise; END IF;

  PERFORM set_config('request.jwt.claims', '', false);
END $$;

-- ---- M5: platform vault is unreachable from client roles ---------
INSERT INTO public.platform_channels
  (channel, provider, secret_ciphertext, secret_iv, secret_tag, secret_fingerprint)
VALUES ('whatsapp', 'meta_cloud', '\xdead', '\x0102030405060708090a0b0c',
        '\x0f0e0d0c0b0a09080706050403020100', 'plat123');

SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}', false);
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.platform_channels;
    RAISE EXCEPTION 'M5a platform vault readable by authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.platform_channels
      (channel, provider, secret_ciphertext, secret_iv, secret_tag, secret_fingerprint)
    VALUES ('sms', 'msg91', '\x00', '\x00', '\x00', 'x');
    RAISE EXCEPTION 'M5b platform vault writable by authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);

-- ---- M6: a school admin can set its own channel mode, not others' -
SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000004"}', false);  -- Admin B
SET ROLE authenticated;
DO $$
DECLARE v integer;
BEGIN
  -- Admin B cannot see school A's modes (RLS scopes by school)
  SELECT count(*) INTO v FROM public.channel_modes
  WHERE school_id = '11111111-1111-1111-1111-111111111111';
  IF v <> 0 THEN RAISE EXCEPTION 'M6a cross-school mode leak: %', v; END IF;

  -- Writing a mode for school A must not take effect (RLS WITH CHECK)
  BEGIN
    INSERT INTO public.channel_modes (school_id, channel, mode)
    VALUES ('11111111-1111-1111-1111-111111111111', 'sms', 'managed');
    RAISE EXCEPTION 'M6b cross-school mode write allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '42501' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);

SELECT 'CHAT22 MANAGED MODE TESTS PASSED' AS result;
