BEGIN;

ALTER TABLE external_effects
  DROP CONSTRAINT IF EXISTS external_effects_effect_type_check;

ALTER TABLE external_effects
  ADD CONSTRAINT external_effects_effect_type_check
  CHECK (effect_type IN (
    'tms-create',
    'pdd-submit',
    'pdd-note',
    'evidence-upload',
    'oms-manual-allocation'
  ));

COMMIT;
