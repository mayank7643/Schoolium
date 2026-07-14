-- ============================================================
-- SCHOOLIUM - CHAT 22 SESSION - ALERTS MANAGED MODE (BYOG + shared)
-- chat22_alerts_managed_mode
-- Generated 14 July 2026 - validated on PostgreSQL 16
-- ============================================================
-- Adds a second delivery mode alongside BYOG so a school can either:
--   * byog    - bring its own gateway API keys (cheap, high limits,
--               priced at provider cost; the school pays the provider)
--   * managed - use Schoolium's own gateways; Schoolium handles the
--               provider relationship and bills the school at
--               Schoolium's rates.
--
-- Mode is chosen PER CHANNEL (a school may BYO WhatsApp but let
-- Schoolium handle email). Default is byog, so applying this migration
-- changes nothing for existing schools.
--
-- Assumes chat21_alerts_byog_foundation.sql is applied.
--
-- What this adds:
--   1. platform_channels   - Schoolium's own credential vault (super
--                            admin only), same AES-256-GCM shape as
--                            school_channels.
--   2. channel_modes       - per (school, channel) mode selector.
--   3. rate_card.mode       - byog vs managed price rows; managed rows
--                            seeded with Schoolium's marked-up rates.
--   4. message_outbox.mode  - stamped per row for the ledger + invoicing.
--   5. channel_templates.email_subject - subject line for email sends.
--   6. alerts_channel_mode(), reworked alerts_message_cost(mode),
--      alerts_render_body(), reworked alerts_enqueue_for_event() and
--      estimate_notice_send() so cost + email rendering are mode-aware.
--
-- Rules honoured: pure ASCII, idempotent, SECURITY DEFINER sets
-- search_path + REVOKE ALL FROM PUBLIC + explicit GRANT, RLS on every
-- tenant table, every table aliased and column qualified.
-- ============================================================


-- ============================================================
-- SECTION 1: PLATFORM CREDENTIAL VAULT (Schoolium's own gateways)
-- Same danger class as school_channels: bearer credentials that spend
-- Schoolium's money. Ciphertext only; key stays in the worker env.
-- Super-admin / service role only; RLS on with zero policies so it is
-- unreachable through PostgREST for anon/authenticated twice over.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.platform_channels (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel            text        NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  provider           text        NOT NULL,   -- meta_cloud | msg91 | resend | generic_http | smtp | fake
  config             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext  bytea       NOT NULL,
  secret_iv          bytea       NOT NULL,
  secret_tag         bytea       NOT NULL,
  secret_fingerprint text        NOT NULL,
  health             text        NOT NULL DEFAULT 'unverified'
                                 CHECK (health IN
                                   ('unverified', 'ok', 'auth_failed', 'low_balance', 'suspended')),
  is_active          boolean     NOT NULL DEFAULT true,
  last_verified_at   timestamptz,
  balance_hint_paise integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, provider)
);

DROP TRIGGER IF EXISTS platform_channels_updated_at ON public.platform_channels;
CREATE TRIGGER platform_channels_updated_at
  BEFORE UPDATE ON public.platform_channels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE ALL ON public.platform_channels FROM anon, authenticated;
ALTER TABLE public.platform_channels ENABLE ROW LEVEL SECURITY;
-- No policies: service role (worker + platform API) only.


-- ============================================================
-- SECTION 2: PER-CHANNEL MODE SELECTOR
-- No row = byog (the safe default; existing behaviour preserved).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.channel_modes (
  school_id  uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  channel    text        NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  mode       text        NOT NULL DEFAULT 'byog' CHECK (mode IN ('byog', 'managed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, channel)
);

DROP TRIGGER IF EXISTS channel_modes_updated_at ON public.channel_modes;
CREATE TRIGGER channel_modes_updated_at
  BEFORE UPDATE ON public.channel_modes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.channel_modes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_manage_channel_modes" ON public.channel_modes;
CREATE POLICY "admin_manage_channel_modes"
  ON public.channel_modes FOR ALL
  USING (school_id = public.get_my_school_id()
         AND public.get_my_role() = 'school_admin')
  WITH CHECK (school_id = public.get_my_school_id()
              AND public.get_my_role() = 'school_admin');

DROP POLICY IF EXISTS "staff_read_channel_modes" ON public.channel_modes;
CREATE POLICY "staff_read_channel_modes"
  ON public.channel_modes FOR SELECT
  USING (school_id = public.get_my_school_id()
         AND public.get_my_role() IN ('school_admin', 'operator', 'principal'));


-- ============================================================
-- SECTION 3: RATE CARD - add mode, seed managed rates
-- byog rows = provider cost (school pays the provider).
-- managed rows = Schoolium's price to the school (marked up to cover
-- Schoolium paying the provider + margin). VERIFY/adjust before you
-- quote; these are placeholders.
-- ============================================================

ALTER TABLE public.rate_card
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'byog';

ALTER TABLE public.rate_card
  DROP CONSTRAINT IF EXISTS rate_card_mode_check;
ALTER TABLE public.rate_card
  ADD CONSTRAINT rate_card_mode_check CHECK (mode IN ('byog', 'managed'));

-- Existing rows predate the column; they are byog (the default).
-- Recreate the PK to include mode.
ALTER TABLE public.rate_card
  DROP CONSTRAINT IF EXISTS rate_card_pkey;
ALTER TABLE public.rate_card
  ADD CONSTRAINT rate_card_pkey PRIMARY KEY (channel, category, mode, effective_from);

-- Managed price list (Schoolium's rates). Adjust freely - add a newer
-- effective_from row rather than editing in place.
INSERT INTO public.rate_card (channel, category, paise, gst_pct, mode, effective_from)
VALUES
  ('whatsapp', 'utility',        30, 18, 'managed', DATE '2026-01-01'),
  ('whatsapp', 'marketing',     120, 18, 'managed', DATE '2026-01-01'),
  ('whatsapp', 'service',        15, 18, 'managed', DATE '2026-01-01'),
  ('sms',      'transactional',  35, 18, 'managed', DATE '2026-01-01'),
  ('sms',      'service',        35, 18, 'managed', DATE '2026-01-01'),
  ('email',    'transactional',  10, 18, 'managed', DATE '2026-01-01'),
  ('email',    'service',        10, 18, 'managed', DATE '2026-01-01')
ON CONFLICT (channel, category, mode, effective_from) DO NOTHING;


-- ============================================================
-- SECTION 4: OUTBOX + TEMPLATE COLUMNS
-- ============================================================

ALTER TABLE public.message_outbox
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'byog';

COMMENT ON COLUMN public.message_outbox.mode IS
  'byog = sent via the school''s own gateway (billed by the provider); '
  'managed = sent via Schoolium''s gateway (billed by Schoolium at '
  'managed rates). Stamped at enqueue for the ledger and invoicing.';

ALTER TABLE public.channel_templates
  ADD COLUMN IF NOT EXISTS email_subject text;

COMMENT ON COLUMN public.channel_templates.email_subject IS
  'Subject line for email channel templates. Supports {{token}} vars '
  'from the same context as the body. Ignored for sms/whatsapp.';


-- ============================================================
-- SECTION 5: HELPERS
-- ============================================================

-- Resolve the effective mode for a (school, channel). No row = byog.
CREATE OR REPLACE FUNCTION public.alerts_channel_mode(
  p_school_id uuid,
  p_channel   text
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT cm.mode FROM public.channel_modes cm
     WHERE cm.school_id = p_school_id AND cm.channel = p_channel),
    'byog'
  );
$$;

REVOKE ALL ON FUNCTION public.alerts_channel_mode(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alerts_channel_mode(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alerts_channel_mode(uuid, text) TO service_role;

-- Render a free-text body: substitute {{token}} from context, unknown
-- tokens -> ''. Used for email subject + body (positional vars stay
-- with alerts_render_vars for sms/whatsapp provider templates).
CREATE OR REPLACE FUNCTION public.alerts_render_body(
  p_body    text,
  p_context jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_out text := COALESCE(p_body, '');
  r     record;
BEGIN
  FOR r IN
    SELECT DISTINCT m[1] AS token
    FROM   regexp_matches(v_out, '\{\{\s*([a-z0-9_]+)\s*\}\}', 'gi') AS m
  LOOP
    v_out := regexp_replace(
      v_out,
      '\{\{\s*' || r.token || '\s*\}\}',
      COALESCE(p_context ->> lower(r.token), ''),
      'gi'
    );
  END LOOP;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.alerts_render_body(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alerts_render_body(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alerts_render_body(text, jsonb) TO service_role;

-- Reworked cost: latest applicable rate for (channel, category, mode).
-- Drop the 2-arg version first; the new 3-arg default keeps old 2-arg
-- callers (send_test_message) working as byog.
DROP FUNCTION IF EXISTS public.alerts_message_cost(text, text);

CREATE OR REPLACE FUNCTION public.alerts_message_cost(
  p_channel  text,
  p_category text,
  p_mode     text DEFAULT 'byog'
)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT round(rc.paise * (1 + rc.gst_pct / 100.0))::integer
    FROM   public.rate_card rc
    WHERE  rc.channel        = p_channel
      AND  rc.category       = p_category
      AND  rc.mode           = COALESCE(p_mode, 'byog')
      AND  rc.effective_from <= CURRENT_DATE
    ORDER BY rc.effective_from DESC
    LIMIT  1
  ), 0);
$$;

REVOKE ALL ON FUNCTION public.alerts_message_cost(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alerts_message_cost(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alerts_message_cost(text, text, text) TO service_role;


-- ============================================================
-- SECTION 6: REWORKED GUARD CHAIN (mode-aware cost + email render)
-- Only the per-candidate section changes vs chat21: resolve the
-- channel mode, price by mode, render email subject/body for the
-- email channel, and stamp message_outbox.mode.
-- ============================================================

CREATE OR REPLACE FUNCTION public.alerts_enqueue_for_event(p_event_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_ev           public.events%ROWTYPE;
  v_school       public.schools%ROWTYPE;
  v_mt           public.message_templates%ROWTYPE;
  v_ct           public.channel_templates%ROWTYPE;
  v_key          text;
  v_tz           text;
  v_local_date   date;
  v_class_filter text;
  v_channels     text[];
  v_cap          integer;
  v_spent        integer;
  v_cost         integer;
  v_mode         text;
  v_tokens       numeric;
  v_refill       numeric;
  v_rate_delay   interval;
  v_next         timestamptz;
  v_ctx          jsonb;
  v_vars         jsonb;
  v_idem         text;
  v_count        integer := 0;
  r              record;
BEGIN
  SELECT ev.* INTO v_ev FROM public.events ev WHERE ev.id = p_event_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT s.* INTO v_school FROM public.schools s WHERE s.id = v_ev.school_id;
  IF NOT FOUND OR NOT v_school.alerts_enabled THEN
    RETURN 0;
  END IF;

  v_tz         := COALESCE(v_school.alerts_timezone, 'Asia/Kolkata');
  v_local_date := (now() AT TIME ZONE v_tz)::date;

  v_key := CASE v_ev.type
             WHEN 'student.checked_in'       THEN 'checkin'
             WHEN 'student.checked_out'      THEN 'checkout'
             WHEN 'student.absent_at_cutoff' THEN 'absent'
             WHEN 'notice.published'         THEN 'notice'
             ELSE NULL
           END;
  IF v_key IS NULL THEN
    RETURN 0;
  END IF;

  IF v_key = 'checkout' AND NOT v_school.checkout_alerts_enabled THEN
    RETURN 0;
  END IF;

  IF v_key IN ('checkin', 'checkout')
     AND v_school.stale_alert_minutes IS NOT NULL
     AND now() - v_ev.occurred_at > make_interval(mins => v_school.stale_alert_minutes) THEN
    INSERT INTO public.alert_notifications (school_id, kind, severity, message, context)
    VALUES (v_ev.school_id, 'stale_suppressed', 'info',
            'Alert suppressed: scan synced more than '
              || v_school.stale_alert_minutes || ' minutes after it happened.',
            jsonb_build_object('event_id', v_ev.id, 'occurred_at', v_ev.occurred_at));
    RETURN 0;
  END IF;

  IF v_ev.type = 'notice.published' THEN
    SELECT mt.* INTO v_mt
    FROM   public.message_templates mt
    WHERE  mt.id        = NULLIF(v_ev.payload ->> 'message_template_id', '')::uuid
      AND  mt.school_id = v_ev.school_id;
  ELSE
    SELECT mt.* INTO v_mt
    FROM   public.message_templates mt
    WHERE  mt.school_id = v_ev.school_id
      AND  mt.key       = v_key;
  END IF;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT array_agg(sub.channel ORDER BY sub.prio)
  INTO   v_channels
  FROM (
    SELECT ct.channel,
           CASE ct.channel WHEN 'whatsapp' THEN 1 WHEN 'sms' THEN 2 ELSE 3 END AS prio
    FROM   public.channel_templates ct
    WHERE  ct.message_template_id = v_mt.id
      AND  ct.approval_status     = 'approved'
  ) sub;
  IF v_channels IS NULL THEN
    RETURN 0;
  END IF;

  v_class_filter := NULLIF(v_ev.payload ->> 'class_label', '');

  INSERT INTO public.spend_guard (school_id) VALUES (v_ev.school_id)
  ON CONFLICT (school_id) DO NOTHING;

  SELECT sg.daily_cap_paise,
         CASE WHEN sg.spent_date = v_local_date THEN sg.spent_today_paise ELSE 0 END
  INTO   v_cap, v_spent
  FROM   public.spend_guard sg
  WHERE  sg.school_id = v_ev.school_id
  FOR UPDATE;

  FOR r IN
    SELECT cand.guardian_id,
           cand.student_id,
           cand.student_name,
           cand.class_label,
           pick.channel,
           pick.value AS recipient
    FROM (
      SELECT DISTINCT ON (sg2.guardian_id)
             sg2.guardian_id,
             st.id        AS student_id,
             st.full_name AS student_name,
             st.class_label
      FROM   public.students st
      JOIN   public.student_guardians sg2 ON sg2.student_id = st.id
      WHERE  st.school_id = v_ev.school_id
        AND  st.is_active = true
        AND  (
               (v_ev.subject_id IS NOT NULL AND st.id = v_ev.subject_id)
            OR (v_ev.subject_id IS NULL
                AND (v_class_filter IS NULL OR st.class_label = v_class_filter))
             )
      ORDER BY sg2.guardian_id, st.full_name, st.id
    ) cand
    JOIN LATERAL (
      SELECT cm.channel, cm.value
      FROM   public.contact_methods cm
      WHERE  cm.guardian_id = cand.guardian_id
        AND  cm.opted_out   = false
        AND  cm.channel     = ANY (v_channels)
      ORDER BY array_position(v_channels, cm.channel), cm.created_at, cm.id
      LIMIT  1
    ) pick ON true
    ORDER BY pick.channel, cand.guardian_id
  LOOP
    SELECT ct.* INTO v_ct
    FROM   public.channel_templates ct
    WHERE  ct.message_template_id = v_mt.id
      AND  ct.channel             = r.channel
      AND  ct.approval_status     = 'approved';
    CONTINUE WHEN NOT FOUND;

    -- NEW: mode drives both the price and (in the worker) which
    -- credential sends. byog = provider cost, managed = Schoolium rate.
    v_mode := public.alerts_channel_mode(v_ev.school_id, r.channel);
    v_cost := public.alerts_message_cost(r.channel, v_ct.category, v_mode);

    IF v_spent + v_cost > v_cap THEN
      INSERT INTO public.alert_notifications
             (school_id, kind, severity, message, context, dedup_key)
      VALUES (v_ev.school_id, 'spend_cap_hit', 'error',
              'Daily spend cap reached. Messages are NOT being sent. '
                || 'Raise the cap in settings if this is legitimate.',
              jsonb_build_object('event_id', v_ev.id,
                                 'cap_paise', v_cap, 'spent_paise', v_spent),
              'spend_cap:' || v_ev.school_id::text || ':' || v_local_date::text)
      ON CONFLICT (school_id, dedup_key) DO NOTHING;
      EXIT;
    END IF;

    INSERT INTO public.channel_rate_limits (school_id, channel)
    VALUES (v_ev.school_id, r.channel)
    ON CONFLICT (school_id, channel) DO NOTHING;

    UPDATE public.channel_rate_limits crl
    SET    tokens = LEAST(
             crl.capacity,
             crl.tokens + EXTRACT(EPOCH FROM (now() - crl.updated_at)) * crl.refill_per_sec
           ) - 1,
           updated_at = now()
    WHERE  crl.school_id = v_ev.school_id
      AND  crl.channel   = r.channel
    RETURNING crl.tokens, crl.refill_per_sec INTO v_tokens, v_refill;

    IF v_tokens < 0 THEN
      v_rate_delay := make_interval(secs => ((-v_tokens) / v_refill)::double precision);
    ELSE
      v_rate_delay := interval '0';
    END IF;

    v_next := GREATEST(
      now() + v_rate_delay,
      public.alerts_quiet_release(now(), v_tz,
                                  v_school.quiet_hours_start, v_school.quiet_hours_end)
    );

    v_ctx := jsonb_build_object(
               'child',       r.student_name,
               'child_first', split_part(COALESCE(r.student_name, ''), ' ', 1),
               'school',      v_school.name,
               'class',       COALESCE(r.class_label, ''),
               'time',        to_char(v_ev.occurred_at AT TIME ZONE v_tz, 'HH12:MI AM'),
               'date',        to_char(v_ev.occurred_at AT TIME ZONE v_tz, 'DD Mon YYYY')
             ) || COALESCE(v_ev.payload -> 'vars', '{}'::jsonb);

    -- NEW: email carries a rendered subject + text body; sms/whatsapp
    -- keep positional provider-template vars.
    IF r.channel = 'email' THEN
      v_vars := jsonb_build_object(
        'subject', public.alerts_render_body(
                     COALESCE(NULLIF(v_ct.email_subject, ''), v_school.name), v_ctx),
        'text',    public.alerts_render_body(v_mt.body, v_ctx));
    ELSE
      v_vars := public.alerts_render_vars(v_ct.var_map, v_ctx);
    END IF;

    v_idem := encode(digest(v_ev.id::text || ':' || r.recipient || ':' || v_ct.id::text,
                            'sha256'), 'hex');

    INSERT INTO public.message_outbox
           (school_id, event_id, channel_template_id, channel, recipient, vars,
            next_attempt_at, cost_estimate_paise, idempotency_key,
            triggered_by, sent_by_user_id, mode)
    VALUES (v_ev.school_id, v_ev.id, v_ct.id, r.channel, r.recipient, v_vars,
            v_next, v_cost, v_idem,
            COALESCE(v_ev.payload ->> 'triggered_by', 'system'),
            NULLIF(v_ev.payload ->> 'published_by', '')::uuid, v_mode)
    ON CONFLICT (school_id, idempotency_key) DO NOTHING;

    IF FOUND THEN
      v_count := v_count + 1;
      v_spent := v_spent + v_cost;
    END IF;
  END LOOP;

  UPDATE public.spend_guard sg
  SET    spent_today_paise = v_spent,
         spent_date        = v_local_date
  WHERE  sg.school_id = v_ev.school_id;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.alerts_enqueue_for_event(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alerts_enqueue_for_event(bigint) TO service_role;


-- ============================================================
-- SECTION 7: MODE-AWARE COMPOSER ESTIMATE
-- ============================================================

CREATE OR REPLACE FUNCTION public.estimate_notice_send(
  p_message_template_id uuid,
  p_class_label         text DEFAULT NULL
)
RETURNS TABLE (recipient_count integer, est_cost_paise bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_role     text;
  v_mt       public.message_templates%ROWTYPE;
  v_channels text[];
BEGIN
  v_role := public.get_my_role();
  IF v_role IS NULL OR v_role NOT IN ('super_admin', 'school_admin', 'operator') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT mt.* INTO v_mt
  FROM   public.message_templates mt
  WHERE  mt.id = p_message_template_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'template_not_found';
  END IF;
  IF v_role <> 'super_admin' AND v_mt.school_id IS DISTINCT FROM public.get_my_school_id() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT array_agg(sub.channel ORDER BY sub.prio)
  INTO   v_channels
  FROM (
    SELECT ct.channel,
           CASE ct.channel WHEN 'whatsapp' THEN 1 WHEN 'sms' THEN 2 ELSE 3 END AS prio
    FROM   public.channel_templates ct
    WHERE  ct.message_template_id = v_mt.id
      AND  ct.approval_status     = 'approved'
  ) sub;

  IF v_channels IS NULL THEN
    RETURN QUERY SELECT 0, 0::bigint;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT count(*)::integer,
         COALESCE(sum(public.alerts_message_cost(
                        pick.channel, pick.category,
                        public.alerts_channel_mode(v_mt.school_id, pick.channel))), 0)::bigint
  FROM (
    SELECT DISTINCT ON (sg2.guardian_id) sg2.guardian_id
    FROM   public.students st
    JOIN   public.student_guardians sg2 ON sg2.student_id = st.id
    WHERE  st.school_id = v_mt.school_id
      AND  st.is_active = true
      AND  (p_class_label IS NULL OR st.class_label = p_class_label)
    ORDER BY sg2.guardian_id
  ) cand
  JOIN LATERAL (
    SELECT cm.channel, ct2.category
    FROM   public.contact_methods cm
    JOIN   public.channel_templates ct2
           ON  ct2.message_template_id = v_mt.id
           AND ct2.channel             = cm.channel
           AND ct2.approval_status     = 'approved'
    WHERE  cm.guardian_id = cand.guardian_id
      AND  cm.opted_out   = false
      AND  cm.channel     = ANY (v_channels)
    ORDER BY array_position(v_channels, cm.channel), cm.created_at, cm.id
    LIMIT  1
  ) pick ON true;
END;
$$;

REVOKE ALL ON FUNCTION public.estimate_notice_send(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.estimate_notice_send(uuid, text) TO authenticated;


-- ============================================================
-- SECTION 8: RELOAD POSTGREST SCHEMA CACHE
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION chat22_alerts_managed_mode
-- ============================================================
