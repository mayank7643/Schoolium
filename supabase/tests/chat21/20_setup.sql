-- ============================================================
-- POST-MIGRATION SETUP: enable alerts for school A, seed
-- templates through the real authenticated paths.
-- ============================================================

-- Operator role only exists after chat21 widened the CHECK.
INSERT INTO public.profiles (id, school_id, full_name, role) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111', 'Operator A', 'operator');

-- Enable the pipeline for school A. Quiet hours disabled
-- (start = end) so timing-sensitive tests are deterministic;
-- the quiet-hours function is unit-tested directly in 30_tests.
UPDATE public.schools
SET    alerts_enabled    = true,
       quiet_hours_start = '00:00',
       quiet_hours_end   = '00:00'
WHERE  id = '11111111-1111-1111-1111-111111111111';

-- Seed the human-layer templates as Admin A (exercises the RPC's
-- auth path: jwt claims -> get_my_role/get_my_school_id).
SELECT set_config('request.jwt.claims',
                  '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}', false);
SET ROLE authenticated;

SELECT public.seed_default_message_templates('11111111-1111-1111-1111-111111111111');

-- Approved channel templates, inserted THROUGH RLS as Admin A.
-- whatsapp/utility for checkin, checkout, absent:
INSERT INTO public.channel_templates
  (school_id, message_template_id, channel, category,
   provider_template_id, var_map, approval_status, approved_at)
SELECT mt.school_id, mt.id, 'whatsapp', 'utility', 'wa_' || mt.key,
       '{"1":"child","2":"school","3":"time"}'::jsonb, 'approved', now()
FROM   public.message_templates mt
WHERE  mt.school_id = '11111111-1111-1111-1111-111111111111'
  AND  mt.key IN ('checkin', 'checkout', 'absent');

-- absent also via email (for the email-only guardian):
INSERT INTO public.channel_templates
  (school_id, message_template_id, channel, category,
   provider_template_id, var_map, approval_status, approved_at)
SELECT mt.school_id, mt.id, 'email', 'service', 'em_' || mt.key,
       '{"1":"child","2":"school","3":"time"}'::jsonb, 'approved', now()
FROM   public.message_templates mt
WHERE  mt.school_id = '11111111-1111-1111-1111-111111111111'
  AND  mt.key = 'absent';

-- notice via whatsapp + email:
INSERT INTO public.channel_templates
  (school_id, message_template_id, channel, category,
   provider_template_id, var_map, approval_status, approved_at)
SELECT mt.school_id, mt.id, x.channel, x.category, x.prefix || mt.key,
       '{"1":"school","2":"message"}'::jsonb, 'approved', now()
FROM   public.message_templates mt
CROSS JOIN (VALUES ('whatsapp', 'utility', 'wa_'),
                   ('email',    'service', 'em_')) AS x(channel, category, prefix)
WHERE  mt.school_id = '11111111-1111-1111-1111-111111111111'
  AND  mt.key = 'notice';

RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);
