BEGIN;

UPDATE work_orders
SET scenario_code = 'in-transit-refund',
    payload = CASE
      WHEN payload->'manualOverrides'->>'scenarioCode' = 'in-transit-no-reason-refund'
        THEN jsonb_set(payload, '{manualOverrides,scenarioCode}', '"in-transit-refund"'::jsonb, true)
      ELSE payload
    END,
    updated_at = now()
WHERE scenario_code = 'in-transit-no-reason-refund'
   OR payload->'manualOverrides'->>'scenarioCode' = 'in-transit-no-reason-refund';

UPDATE tms_work_orders
SET scenario_code = 'in-transit-refund'
WHERE scenario_code = 'in-transit-no-reason-refund';

DELETE FROM scenario_definitions
WHERE code = 'in-transit-no-reason-refund';

COMMIT;
