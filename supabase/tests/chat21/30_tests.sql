-- ============================================================
-- FUNCTIONAL TESTS - chat21 alerts pipeline
-- Every DO block raises on failure; ON_ERROR_STOP aborts the run.
-- ============================================================

\set ON_ERROR_STOP on

-- ---- T1: phone normaliser ------------------------------------
DO $$
BEGIN
  IF public.normalize_phone_e164('98765 43210')     IS DISTINCT FROM '+919876543210' THEN RAISE EXCEPTION 'T1a'; END IF;
  IF public.normalize_phone_e164('098765-43210')    IS DISTINCT FROM '+919876543210' THEN RAISE EXCEPTION 'T1b'; END IF;
  IF public.normalize_phone_e164('919876543210')    IS DISTINCT FROM '+919876543210' THEN RAISE EXCEPTION 'T1c'; END IF;
  IF public.normalize_phone_e164('+91 98765 43210') IS DISTINCT FROM '+919876543210' THEN RAISE EXCEPTION 'T1d'; END IF;
  IF public.normalize_phone_e164('not-a-phone') IS NOT NULL THEN RAISE EXCEPTION 'T1e'; END IF;
  IF public.normalize_phone_e164('12345')       IS NOT NULL THEN RAISE EXCEPTION 'T1f'; END IF;
  IF public.normalize_phone_e164(NULL)          IS NOT NULL THEN RAISE EXCEPTION 'T1g'; END IF;
END $$;

-- ---- T2: directory + external_ref/class_label backfills -------
DO $$
DECLARE
  v  integer;
  g1 uuid;
  g2 uuid;
BEGIN
  -- siblings A1 + A2 share one guardian (same normalised phone)
  SELECT sg.guardian_id INTO g1 FROM public.student_guardians sg
  WHERE  sg.student_id = 'dddddddd-0000-0000-0000-000000000001';
  SELECT sg.guardian_id INTO g2 FROM public.student_guardians sg
  WHERE  sg.student_id = 'dddddddd-0000-0000-0000-000000000002';
  IF g1 IS NULL OR g1 IS DISTINCT FROM g2 THEN RAISE EXCEPTION 'T2a sibling guardian dedupe'; END IF;

  -- shared phone became whatsapp + sms contact methods
  SELECT count(*) INTO v FROM public.contact_methods cm
  WHERE  cm.guardian_id = g1 AND cm.value = '+919876543210';
  IF v <> 2 THEN RAISE EXCEPTION 'T2b contact methods, got %', v; END IF;

  -- legacy opt-out flag copied onto phone contacts (A3)
  SELECT count(*) INTO v
  FROM   public.contact_methods cm
  JOIN   public.student_guardians sg ON sg.guardian_id = cm.guardian_id
  WHERE  sg.student_id = 'dddddddd-0000-0000-0000-000000000003'
    AND  cm.opted_out = true;
  IF v <> 2 THEN RAISE EXCEPTION 'T2c opted_out copy, got %', v; END IF;

  -- email contact lowercased (A4)
  SELECT count(*) INTO v
  FROM   public.contact_methods cm
  JOIN   public.student_guardians sg ON sg.guardian_id = cm.guardian_id
  WHERE  sg.student_id = 'dddddddd-0000-0000-0000-000000000004'
    AND  cm.channel = 'email' AND cm.value = 'nina.mehta@example.com';
  IF v <> 1 THEN RAISE EXCEPTION 'T2d email contact'; END IF;

  -- A5 has no usable contact -> no guardian link
  SELECT count(*) INTO v FROM public.student_guardians sg
  WHERE  sg.student_id = 'dddddddd-0000-0000-0000-000000000005';
  IF v <> 0 THEN RAISE EXCEPTION 'T2e no-contact student linked'; END IF;

  -- external_ref backfill: unique uid copied, in-school dup left NULL,
  -- cross-school dup copied
  IF (SELECT s.external_ref FROM public.students s WHERE s.id = 'dddddddd-0000-0000-0000-000000000001') IS DISTINCT FROM 'S1' THEN RAISE EXCEPTION 'T2f'; END IF;
  IF (SELECT s.external_ref FROM public.students s WHERE s.id = 'dddddddd-0000-0000-0000-000000000003') IS NOT NULL THEN RAISE EXCEPTION 'T2g dup uid copied'; END IF;
  IF (SELECT s.external_ref FROM public.students s WHERE s.id = 'dddddddd-0000-0000-0000-000000000007') IS DISTINCT FROM 'S1' THEN RAISE EXCEPTION 'T2h'; END IF;

  -- class_label backfill from classes ("5" + "A" -> "5-A")
  IF (SELECT s.class_label FROM public.students s WHERE s.id = 'dddddddd-0000-0000-0000-000000000001') IS DISTINCT FROM '5-A' THEN RAISE EXCEPTION 'T2i'; END IF;
END $$;

-- ---- T3: gate scan -> event -> outbox --------------------------
-- Guard A scans A1 with a scan_time 95 minutes in the past
-- (offline queue sync). stale_alert_minutes is NULL so it sends.
SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}', false);
SET ROLE authenticated;
INSERT INTO public.attendance (school_id, student_id, scan_date, scan_time, entry_type, gate, guard_id)
VALUES ('11111111-1111-1111-1111-111111111111',
        'dddddddd-0000-0000-0000-000000000001',
        (now() AT TIME ZONE 'Asia/Kolkata')::date,
        now() - interval '95 minutes', 'entry', 'Main Gate',
        'aaaaaaaa-0000-0000-0000-000000000002');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);

DO $$
DECLARE
  e public.events%ROWTYPE;
  m public.message_outbox%ROWTYPE;
  v integer;
BEGIN
  SELECT ev.* INTO e FROM public.events ev
  WHERE  ev.school_id = '11111111-1111-1111-1111-111111111111'
    AND  ev.type = 'student.checked_in'
    AND  ev.subject_id = 'dddddddd-0000-0000-0000-000000000001';
  IF NOT FOUND THEN RAISE EXCEPTION 'T3a event missing'; END IF;
  IF e.dedup_key NOT LIKE 'checkin:dddddddd-0000-0000-0000-000000000001:%' THEN RAISE EXCEPTION 'T3b dedup key'; END IF;

  -- occurred_at is the ORIGINAL scan time, not sync/insert time
  IF abs(extract(epoch FROM (e.occurred_at - (now() - interval '95 minutes')))) > 10 THEN
    RAISE EXCEPTION 'T3c occurred_at drift';
  END IF;

  SELECT mo.* INTO m FROM public.message_outbox mo WHERE mo.event_id = e.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'T3d outbox missing'; END IF;
  IF m.channel <> 'whatsapp' THEN RAISE EXCEPTION 'T3e channel priority'; END IF;
  IF m.recipient <> '+919876543210' THEN RAISE EXCEPTION 'T3f recipient'; END IF;
  IF m.vars ->> '1' <> 'Aayush Ray' THEN RAISE EXCEPTION 'T3g var 1: %', m.vars; END IF;
  IF m.vars ->> '2' <> 'Sunrise Public School' THEN RAISE EXCEPTION 'T3g var 2'; END IF;
  IF m.vars ->> '3' <> to_char(e.occurred_at AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM') THEN
    RAISE EXCEPTION 'T3h time rendered from occurred_at, got %', m.vars ->> '3';
  END IF;
  IF m.cost_estimate_paise <> 14 THEN RAISE EXCEPTION 'T3i cost % (12 paise + 18pct GST)', m.cost_estimate_paise; END IF;
  IF m.status <> 'queued' THEN RAISE EXCEPTION 'T3j status'; END IF;
  IF m.triggered_by <> 'scan' THEN RAISE EXCEPTION 'T3k attribution'; END IF;

  SELECT sg.spent_today_paise INTO v FROM public.spend_guard sg
  WHERE  sg.school_id = '11111111-1111-1111-1111-111111111111';
  IF v <> 14 THEN RAISE EXCEPTION 'T3l spend reserved, got %', v; END IF;

  -- Re-running enqueue for the same event must be a no-op
  PERFORM public.alerts_enqueue_for_event(e.id);
  SELECT count(*) INTO v FROM public.message_outbox mo WHERE mo.event_id = e.id;
  IF v <> 1 THEN RAISE EXCEPTION 'T3m idempotency, got %', v; END IF;
END $$;

-- ---- T4: opted-out guardian is skipped (consent guard) ---------
SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}', false);
SET ROLE authenticated;
INSERT INTO public.attendance (school_id, student_id, scan_date, entry_type, guard_id)
VALUES ('11111111-1111-1111-1111-111111111111',
        'dddddddd-0000-0000-0000-000000000003',
        (now() AT TIME ZONE 'Asia/Kolkata')::date, 'entry',
        'aaaaaaaa-0000-0000-0000-000000000002');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);

DO $$
DECLARE v integer;
BEGIN
  SELECT count(*) INTO v
  FROM   public.message_outbox mo
  JOIN   public.events ev ON ev.id = mo.event_id
  WHERE  ev.subject_id = 'dddddddd-0000-0000-0000-000000000003';
  IF v <> 0 THEN RAISE EXCEPTION 'T4 opted-out guardian was messaged'; END IF;
END $$;

-- ---- T5: checkout alerts disabled by default -------------------
SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}', false);
SET ROLE authenticated;
INSERT INTO public.attendance (school_id, student_id, scan_date, entry_type, guard_id)
VALUES ('11111111-1111-1111-1111-111111111111',
        'dddddddd-0000-0000-0000-000000000001',
        (now() AT TIME ZONE 'Asia/Kolkata')::date, 'exit',
        'aaaaaaaa-0000-0000-0000-000000000002');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);

DO $$
DECLARE v integer;
BEGIN
  -- event is still recorded (audit spine) ...
  SELECT count(*) INTO v FROM public.events ev
  WHERE  ev.type = 'student.checked_out'
    AND  ev.subject_id = 'dddddddd-0000-0000-0000-000000000001';
  IF v <> 1 THEN RAISE EXCEPTION 'T5a checkout event missing'; END IF;
  -- ... but no message goes out while checkout_alerts_enabled=false
  SELECT count(*) INTO v
  FROM   public.message_outbox mo
  JOIN   public.events ev ON ev.id = mo.event_id
  WHERE  ev.type = 'student.checked_out';
  IF v <> 0 THEN RAISE EXCEPTION 'T5b checkout messaged while disabled'; END IF;
END $$;

-- ---- T6: stale scan suppression (school setting) ---------------
UPDATE public.schools SET stale_alert_minutes = 30
WHERE  id = '11111111-1111-1111-1111-111111111111';

SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}', false);
SET ROLE authenticated;
INSERT INTO public.attendance (school_id, student_id, scan_date, scan_time, entry_type, guard_id)
VALUES ('11111111-1111-1111-1111-111111111111',
        'dddddddd-0000-0000-0000-000000000005',
        (now() AT TIME ZONE 'Asia/Kolkata')::date,
        now() - interval '40 minutes', 'entry',
        'aaaaaaaa-0000-0000-0000-000000000002');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);

DO $$
DECLARE v integer;
BEGIN
  SELECT count(*) INTO v FROM public.alert_notifications an
  WHERE  an.school_id = '11111111-1111-1111-1111-111111111111'
    AND  an.kind = 'stale_suppressed';
  IF v <> 1 THEN RAISE EXCEPTION 'T6 stale suppression notification, got %', v; END IF;
END $$;

UPDATE public.schools SET stale_alert_minutes = NULL
WHERE  id = '11111111-1111-1111-1111-111111111111';

-- ---- T7: quiet hours release function --------------------------
DO $$
DECLARE r timestamptz;
BEGIN
  -- 22:00 IST inside the overnight window -> next day 06:30 IST
  r := public.alerts_quiet_release(
         '2026-07-08 22:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata',
         'Asia/Kolkata', '21:00'::time, '06:30'::time);
  IF (r AT TIME ZONE 'Asia/Kolkata') <> '2026-07-09 06:30:00'::timestamp THEN
    RAISE EXCEPTION 'T7a got %', r AT TIME ZONE 'Asia/Kolkata';
  END IF;
  -- 02:00 IST -> same day 06:30 IST
  r := public.alerts_quiet_release(
         '2026-07-09 02:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata',
         'Asia/Kolkata', '21:00'::time, '06:30'::time);
  IF (r AT TIME ZONE 'Asia/Kolkata') <> '2026-07-09 06:30:00'::timestamp THEN
    RAISE EXCEPTION 'T7b got %', r AT TIME ZONE 'Asia/Kolkata';
  END IF;
  -- 12:00 IST outside the window -> unchanged
  r := public.alerts_quiet_release(
         '2026-07-09 12:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata',
         'Asia/Kolkata', '21:00'::time, '06:30'::time);
  IF r <> '2026-07-09 12:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata' THEN
    RAISE EXCEPTION 'T7c got %', r;
  END IF;
  -- start = end -> disabled
  r := public.alerts_quiet_release(
         '2026-07-08 22:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata',
         'Asia/Kolkata', '00:00'::time, '00:00'::time);
  IF r <> '2026-07-08 22:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata' THEN
    RAISE EXCEPTION 'T7d got %', r;
  END IF;
END $$;

-- ---- T8: spend cap blocks the insert, loudly -------------------
UPDATE public.spend_guard SET daily_cap_paise = spent_today_paise + 5
WHERE  school_id = '11111111-1111-1111-1111-111111111111';

SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}', false);
SET ROLE authenticated;
INSERT INTO public.attendance (school_id, student_id, scan_date, entry_type, guard_id)
VALUES ('11111111-1111-1111-1111-111111111111',
        'dddddddd-0000-0000-0000-000000000002',
        (now() AT TIME ZONE 'Asia/Kolkata')::date, 'entry',
        'aaaaaaaa-0000-0000-0000-000000000002');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);

DO $$
DECLARE v integer;
BEGIN
  SELECT count(*) INTO v
  FROM   public.message_outbox mo
  JOIN   public.events ev ON ev.id = mo.event_id
  WHERE  ev.subject_id = 'dddddddd-0000-0000-0000-000000000002';
  IF v <> 0 THEN RAISE EXCEPTION 'T8a message sent past the cap'; END IF;

  SELECT count(*) INTO v FROM public.alert_notifications an
  WHERE  an.school_id = '11111111-1111-1111-1111-111111111111'
    AND  an.kind = 'spend_cap_hit';
  IF v <> 1 THEN RAISE EXCEPTION 'T8b spend_cap_hit notification, got %', v; END IF;
END $$;

UPDATE public.spend_guard SET daily_cap_paise = 500000
WHERE  school_id = '11111111-1111-1111-1111-111111111111';

-- ---- T9: rate limit spreads, never drops -----------------------
UPDATE public.channel_rate_limits SET tokens = -10, updated_at = now()
WHERE  school_id = '11111111-1111-1111-1111-111111111111' AND channel = 'whatsapp';

SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000002"}', false);
SET ROLE authenticated;
INSERT INTO public.attendance (school_id, student_id, scan_date, entry_type, guard_id)
VALUES ('11111111-1111-1111-1111-111111111111',
        'dddddddd-0000-0000-0000-000000000006',
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
  WHERE  ev.subject_id = 'dddddddd-0000-0000-0000-000000000006';
  IF NOT FOUND THEN RAISE EXCEPTION 'T9a rate limit dropped the message'; END IF;
  IF m.status <> 'queued' THEN RAISE EXCEPTION 'T9b'; END IF;
  IF m.next_attempt_at < now() + interval '3 seconds'
     OR m.next_attempt_at > now() + interval '20 seconds' THEN
    RAISE EXCEPTION 'T9c expected ~5.5s smear, got %', m.next_attempt_at - now();
  END IF;
END $$;

UPDATE public.channel_rate_limits SET tokens = 300, updated_at = now()
WHERE  school_id = '11111111-1111-1111-1111-111111111111' AND channel = 'whatsapp';

-- ---- T10: worker claim / backoff / dead-letter / webhooks ------
CREATE TEMP TABLE t_ids (k text PRIMARY KEY, v bigint);
INSERT INTO t_ids
SELECT 'a1_msg', mo.id FROM public.message_outbox mo
JOIN   public.events ev ON ev.id = mo.event_id
WHERE  ev.subject_id = 'dddddddd-0000-0000-0000-000000000001'
  AND  ev.type = 'student.checked_in';
INSERT INTO t_ids
SELECT 'a6_msg', mo.id FROM public.message_outbox mo
JOIN   public.events ev ON ev.id = mo.event_id
WHERE  ev.subject_id = 'dddddddd-0000-0000-0000-000000000006';

GRANT SELECT ON t_ids TO service_role;

SET ROLE service_role;
CREATE TEMP TABLE t_claim1 AS SELECT * FROM public.claim_outbox_batch(10);
CREATE TEMP TABLE t_claim2 AS SELECT * FROM public.claim_outbox_batch(10);
RESET ROLE;

DO $$
DECLARE v integer; m public.message_outbox%ROWTYPE;
BEGIN
  -- Only the A1 row is due (A6 is rate-smeared into the future)
  SELECT count(*) INTO v FROM t_claim1;
  IF v <> 1 THEN RAISE EXCEPTION 'T10a claimed %, expected 1', v; END IF;
  IF (SELECT c.id FROM t_claim1 c) <> (SELECT t.v FROM t_ids t WHERE t.k = 'a1_msg') THEN
    RAISE EXCEPTION 'T10b wrong row claimed';
  END IF;
  -- Claimed row is now 'sending' and cannot be claimed twice
  SELECT mo.* INTO m FROM public.message_outbox mo
  WHERE  mo.id = (SELECT t.v FROM t_ids t WHERE t.k = 'a1_msg');
  IF m.status <> 'sending' THEN RAISE EXCEPTION 'T10c'; END IF;
  SELECT count(*) INTO v FROM t_claim2;
  IF v <> 0 THEN RAISE EXCEPTION 'T10d double claim'; END IF;

  -- Transient failure -> backoff (2^1 * 30s * 0.8..1.2 jitter)
  PERFORM public.complete_outbox_send(m.id, 'failed', NULL, 'HTTP_500', 'gateway timeout', false);
  SELECT mo.* INTO m FROM public.message_outbox mo WHERE mo.id = m.id;
  IF m.status <> 'failed' OR m.attempts <> 1 THEN RAISE EXCEPTION 'T10e'; END IF;
  IF m.next_attempt_at < now() + interval '40 seconds'
     OR m.next_attempt_at > now() + interval '80 seconds' THEN
    RAISE EXCEPTION 'T10f backoff out of range: %', m.next_attempt_at - now();
  END IF;
END $$;

-- Force due again, reclaim, complete as sent, then walk the ledger.
UPDATE public.message_outbox SET next_attempt_at = now() - interval '1 second'
WHERE  id = (SELECT t.v FROM t_ids t WHERE t.k = 'a1_msg');

SET ROLE service_role;
CREATE TEMP TABLE t_claim3 AS SELECT * FROM public.claim_outbox_batch(10);
RESET ROLE;

DO $$
DECLARE v integer; v_id bigint;
BEGIN
  v_id := (SELECT t.v FROM t_ids t WHERE t.k = 'a1_msg');
  SELECT count(*) INTO v FROM t_claim3;
  IF v <> 1 THEN RAISE EXCEPTION 'T10g reclaim, got %', v; END IF;

  PERFORM public.complete_outbox_send(v_id, 'sent', 'PM1');
  IF (SELECT mo.status FROM public.message_outbox mo WHERE mo.id = v_id) <> 'sent'
     OR (SELECT mo.sent_at FROM public.message_outbox mo WHERE mo.id = v_id) IS NULL THEN
    RAISE EXCEPTION 'T10h sent state';
  END IF;

  -- Webhook ledger: forward-only transitions, school-scoped
  IF public.apply_delivery_status('22222222-2222-2222-2222-222222222222', 'PM1', 'delivered') <> 0 THEN
    RAISE EXCEPTION 'T10i cross-school webhook applied';
  END IF;
  IF public.apply_delivery_status('11111111-1111-1111-1111-111111111111', 'PM1', 'delivered') <> 1 THEN
    RAISE EXCEPTION 'T10j delivered';
  END IF;
  IF public.apply_delivery_status('11111111-1111-1111-1111-111111111111', 'PM1', 'read') <> 1 THEN
    RAISE EXCEPTION 'T10k read';
  END IF;
  IF public.apply_delivery_status('11111111-1111-1111-1111-111111111111', 'PM1', 'delivered') <> 0 THEN
    RAISE EXCEPTION 'T10l backwards transition applied';
  END IF;

  -- Permanent failure -> dead immediately (no retries of auth errors)
  UPDATE public.message_outbox SET next_attempt_at = now() - interval '1 second'
  WHERE  id = (SELECT t.v FROM t_ids t WHERE t.k = 'a6_msg');
  PERFORM public.claim_outbox_batch(10);
  PERFORM public.complete_outbox_send(
    (SELECT t.v FROM t_ids t WHERE t.k = 'a6_msg'),
    'failed', NULL, 'AUTH_401', 'Meta rejected this: invalid access token', true);
  IF (SELECT mo.status FROM public.message_outbox mo
      WHERE mo.id = (SELECT t.v FROM t_ids t WHERE t.k = 'a6_msg')) <> 'dead' THEN
    RAISE EXCEPTION 'T10m dead letter';
  END IF;
END $$;

-- ---- T11: absent-at-cutoff -------------------------------------
-- Scanned today: A1, A2, A3, A5, A6. Not scanned: A4 (email guardian).
UPDATE public.schools
SET    absent_cutoff_time = ((now() AT TIME ZONE 'Asia/Kolkata') - interval '1 minute')::time
WHERE  id = '11111111-1111-1111-1111-111111111111';
-- School B has a cutoff but alerts disabled: must be ignored.
UPDATE public.schools SET absent_cutoff_time = '00:01'
WHERE  id = '22222222-2222-2222-2222-222222222222';

SELECT public.run_absent_cutoff();

DO $$
DECLARE v integer; m public.message_outbox%ROWTYPE;
BEGIN
  SELECT ar.emitted_count INTO v FROM public.absent_runs ar
  WHERE  ar.school_id = '11111111-1111-1111-1111-111111111111'
    AND  ar.run_date = (now() AT TIME ZONE 'Asia/Kolkata')::date;
  IF NOT FOUND THEN RAISE EXCEPTION 'T11a absent_run missing'; END IF;
  IF v <> 1 THEN RAISE EXCEPTION 'T11b emitted %, expected 1 (A4)', v; END IF;

  SELECT mo.* INTO m
  FROM   public.message_outbox mo
  JOIN   public.events ev ON ev.id = mo.event_id
  WHERE  ev.type = 'student.absent_at_cutoff'
    AND  ev.subject_id = 'dddddddd-0000-0000-0000-000000000004';
  IF NOT FOUND THEN RAISE EXCEPTION 'T11c absent alert missing'; END IF;
  IF m.channel <> 'email' OR m.recipient <> 'nina.mehta@example.com' THEN
    RAISE EXCEPTION 'T11d channel/recipient';
  END IF;
  IF m.vars ->> '1' <> 'Dev Mehta' THEN RAISE EXCEPTION 'T11e vars'; END IF;

  -- Idempotent: a second sweep emits nothing new
  PERFORM public.run_absent_cutoff();
  SELECT count(*) INTO v FROM public.events ev WHERE ev.type = 'student.absent_at_cutoff';
  IF v <> 1 THEN RAISE EXCEPTION 'T11f second run emitted, got %', v; END IF;

  -- School B untouched (alerts disabled)
  SELECT count(*) INTO v FROM public.absent_runs ar
  WHERE  ar.school_id = '22222222-2222-2222-2222-222222222222';
  IF v <> 0 THEN RAISE EXCEPTION 'T11g disabled school ran'; END IF;
END $$;

-- ---- T12: composer - estimate, publish, guardian dedupe --------
DO $$
DECLARE
  v_mt   uuid;
  v_cnt  integer;
  v_cost bigint;
  res    jsonb;
  eid    bigint;
  v      integer;
BEGIN
  PERFORM set_config('request.jwt.claims',
                     '{"sub":"aaaaaaaa-0000-0000-0000-000000000003"}', false);

  SELECT mt.id INTO v_mt FROM public.message_templates mt
  WHERE  mt.school_id = '11111111-1111-1111-1111-111111111111' AND mt.key = 'notice';

  -- Confirm screen numbers: G1 (wa) + G4 (email) + G6 (wa) = 3
  -- recipients; cost = 14 + 0 + 14 = 28 paise incl GST.
  SELECT ens.recipient_count, ens.est_cost_paise INTO v_cnt, v_cost
  FROM   public.estimate_notice_send(v_mt, NULL) ens;
  IF v_cnt <> 3 THEN RAISE EXCEPTION 'T12a recipients %, expected 3', v_cnt; END IF;
  IF v_cost <> 28 THEN RAISE EXCEPTION 'T12b cost %, expected 28', v_cost; END IF;

  res := public.publish_notice(v_mt, '{"message":"PTM on Friday"}'::jsonb, NULL);
  IF (res ->> 'queued')::integer <> 3 THEN RAISE EXCEPTION 'T12c queued %', res ->> 'queued'; END IF;
  eid := (res ->> 'event_id')::bigint;

  -- Guardian dedupe: the shared-phone guardian of A1+A2 gets ONE message
  SELECT count(*) INTO v FROM public.message_outbox mo
  WHERE  mo.event_id = eid AND mo.recipient = '+919876543210';
  IF v <> 1 THEN RAISE EXCEPTION 'T12d guardian dedupe, got %', v; END IF;

  -- Vars rendered on every channel
  SELECT count(*) INTO v FROM public.message_outbox mo
  WHERE  mo.event_id = eid AND mo.vars ->> '2' = 'PTM on Friday'
    AND  mo.vars ->> '1' = 'Sunrise Public School';
  IF v <> 3 THEN RAISE EXCEPTION 'T12e vars, got %', v; END IF;

  -- Attribution: composer + the operator's user id
  SELECT count(*) INTO v FROM public.message_outbox mo
  WHERE  mo.event_id = eid AND mo.triggered_by = 'composer'
    AND  mo.sent_by_user_id = 'aaaaaaaa-0000-0000-0000-000000000003';
  IF v <> 3 THEN RAISE EXCEPTION 'T12f attribution'; END IF;

  -- Delivery stats RPC (the sales-demo screen)
  SELECT gs.n_total INTO v FROM public.get_notice_delivery_stats(eid) gs;
  IF v <> 3 THEN RAISE EXCEPTION 'T12g stats'; END IF;

  -- Class filter: only the 5-A guardian
  res := public.publish_notice(v_mt, '{"message":"5-A only"}'::jsonb, '5-A');
  IF (res ->> 'queued')::integer <> 1 THEN RAISE EXCEPTION 'T12h class filter, got %', res ->> 'queued'; END IF;

  PERFORM set_config('request.jwt.claims', '', false);
END $$;

-- ---- T13: send test message (onboarding "the moment") ----------
DO $$
DECLARE v_ct uuid; v_id bigint; m public.message_outbox%ROWTYPE;
BEGIN
  PERFORM set_config('request.jwt.claims',
                     '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}', false);
  SELECT ct.id INTO v_ct
  FROM   public.channel_templates ct
  JOIN   public.message_templates mt ON mt.id = ct.message_template_id
  WHERE  mt.key = 'checkin' AND ct.channel = 'whatsapp'
    AND  ct.school_id = '11111111-1111-1111-1111-111111111111';

  v_id := public.send_test_message(v_ct, '+919999999999');
  SELECT mo.* INTO m FROM public.message_outbox mo WHERE mo.id = v_id;
  IF m.triggered_by <> 'test' OR m.recipient <> '+919999999999'
     OR m.sent_by_user_id <> 'aaaaaaaa-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'T13 test message';
  END IF;
  PERFORM set_config('request.jwt.claims', '', false);
END $$;

SELECT 'FUNCTIONAL TESTS PASSED' AS result;
