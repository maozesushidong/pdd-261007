BEGIN;

INSERT INTO scenario_definitions (code, title_patterns, policy_version, enabled, config)
VALUES
  (
    'delivery-risk-concern',
    '["消费者担忧货物无法送达"]'::jsonb,
    2,
    true,
    '{"displayName":"消费者担忧货物无法送达","displayOrder":40,"requiresPdd":true,"requiresOms":false,"conditionalOms":true,"requiresTms":false,"conditionalTms":true,"allowAutoSubmit":true}'::jsonb
  ),
  (
    'proactive-logistics-service',
    '["物流异常主动服务"]'::jsonb,
    1,
    true,
    '{"displayName":"物流异常主动服务","displayOrder":50,"requiresPdd":true,"requiresOms":false,"requiresTms":false,"allowAutoSubmit":true}'::jsonb
  ),
  (
    'intercept-recall',
    '["消费者申请退款后提示拦截"]'::jsonb,
    2,
    true,
    '{"displayName":"消费者申请退款后提示拦截","displayOrder":60,"requiresPdd":true,"requiresOms":true,"requiresTms":true,"allowAutoSubmit":true}'::jsonb
  ),
  (
    'good-deed-expedited-shipping',
    '["好人好事"]'::jsonb,
    1,
    true,
    '{"displayName":"好人好事服务单-加急发货","displayOrder":70,"requiresPdd":true,"requiresOms":true,"requiresTms":false,"allowAutoSubmit":true,"titleMatchMode":"contains"}'::jsonb
  )
ON CONFLICT (code) DO UPDATE SET
  title_patterns = EXCLUDED.title_patterns,
  policy_version = EXCLUDED.policy_version,
  enabled = EXCLUDED.enabled,
  config = EXCLUDED.config,
  updated_at = now();

UPDATE scenario_definitions scenario
SET config = scenario.config || metadata.config,
  updated_at = now()
FROM (VALUES
  ('in-transit-refund', '{"displayName":"在途无理由退款处理","displayOrder":10,"requiresPdd":true,"requiresOms":true,"requiresTms":true,"allowAutoSubmit":true}'::jsonb),
  ('shipped-no-tracking-refund', '{"displayName":"已发货无轨迹退款","displayOrder":20,"requiresPdd":true,"requiresOms":true,"requiresTms":true,"allowAutoSubmit":true}'::jsonb),
  ('abnormal-network-warning', '{"displayName":"异常网点预警","displayOrder":30,"requiresPdd":true,"requiresOms":true,"requiresTms":false,"allowAutoSubmit":true}'::jsonb),
  ('return-refund', '{"displayName":"退货退款","displayOrder":35,"requiresPdd":true,"requiresOms":false,"requiresTms":false,"allowAutoSubmit":true}'::jsonb)
) AS metadata(code, config)
WHERE scenario.code = metadata.code;

UPDATE shops shop
SET scenario_codes = ARRAY(
    SELECT item.code
    FROM unnest(
      coalesce(shop.scenario_codes, ARRAY[]::text[]) || ARRAY[
        'delivery-risk-concern',
        'proactive-logistics-service',
        'intercept-recall',
        'good-deed-expedited-shipping'
      ]::text[]
    ) WITH ORDINALITY AS item(code, position)
    GROUP BY item.code
    ORDER BY min(item.position)
  ),
  config_version = config_version + 1,
  updated_at = now()
WHERE NOT (
  ARRAY[
    'delivery-risk-concern',
    'proactive-logistics-service',
    'intercept-recall',
    'good-deed-expedited-shipping'
  ]::text[] <@ coalesce(shop.scenario_codes, ARRAY[]::text[])
);

ALTER TABLE shops
  ALTER COLUMN scenario_codes SET DEFAULT ARRAY[
    'in-transit-refund',
    'shipped-no-tracking-refund',
    'abnormal-network-warning',
    'return-refund',
    'delivery-risk-concern',
    'proactive-logistics-service',
    'intercept-recall',
    'good-deed-expedited-shipping'
  ]::text[];

CREATE TABLE IF NOT EXISTS ordinary_work_order_instances (
  id uuid PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  shop_id text NOT NULL REFERENCES shops(id),
  platform_case_id text,
  platform_case_key text,
  detail_url text,
  work_order_type text NOT NULL,
  scenario_code text NOT NULL,
  identity_status text NOT NULL DEFAULT 'verified'
    CHECK (identity_status IN ('verified', 'legacy-unverified')),
  status text NOT NULL DEFAULT 'discovered',
  runtime_status text NOT NULL DEFAULT 'queued',
  current_step text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  manual_review_reason text,
  next_attempt_at timestamptz,
  first_discovered_at timestamptz NOT NULL DEFAULT now(),
  last_discovered_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  completion_method text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      identity_status = 'verified'
      AND platform_case_id ~ '^[0-9]{6,30}$'
      AND platform_case_key = 'pdd-work-order:' || platform_case_id
      AND detail_url ~* '^https://mms[.]pinduoduo[.]com/aftersales/work_order/tododetail/?[?]'
      AND substring(detail_url FROM '[?&]id=([0-9]{6,30})(&|$)') = platform_case_id
    )
    OR (
      identity_status = 'legacy-unverified'
      AND platform_case_id IS NULL
      AND platform_case_key IS NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ordinary_instances_platform_case
  ON ordinary_work_order_instances (platform_case_key)
  WHERE platform_case_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ordinary_instances_legacy_work_order
  ON ordinary_work_order_instances (work_order_id)
  WHERE identity_status = 'legacy-unverified' AND platform_case_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_ordinary_instances_work_order
  ON ordinary_work_order_instances (work_order_id, last_discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_ordinary_instances_due
  ON ordinary_work_order_instances (shop_id, runtime_status, next_attempt_at, first_discovered_at);

CREATE OR REPLACE FUNCTION enforce_ordinary_instance_shop_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM work_orders work_order
    WHERE work_order.id = NEW.work_order_id
      AND work_order.shop_id = NEW.shop_id
  ) THEN
    RAISE EXCEPTION
      'ordinary instance shop % does not match work order %',
      NEW.shop_id,
      NEW.work_order_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_ordinary_instance_shop_ownership
  ON ordinary_work_order_instances;
CREATE TRIGGER trg_enforce_ordinary_instance_shop_ownership
BEFORE INSERT OR UPDATE OF work_order_id, shop_id
ON ordinary_work_order_instances
FOR EACH ROW
EXECUTE FUNCTION enforce_ordinary_instance_shop_ownership();

CREATE OR REPLACE FUNCTION enforce_work_order_ordinary_instance_shops()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ordinary_work_order_instances instance
    WHERE instance.work_order_id = NEW.id
      AND instance.shop_id <> NEW.shop_id
  ) THEN
    RAISE EXCEPTION
      'work order shop % does not match one or more ordinary instances for %',
      NEW.shop_id,
      NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_work_order_ordinary_instance_shops ON work_orders;
CREATE CONSTRAINT TRIGGER trg_enforce_work_order_ordinary_instance_shops
AFTER INSERT OR UPDATE
ON work_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_work_order_ordinary_instance_shops();

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS current_ordinary_instance_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_orders'::regclass
      AND conname = 'work_orders_current_ordinary_instance_fk'
  ) THEN
    ALTER TABLE work_orders
      ADD CONSTRAINT work_orders_current_ordinary_instance_fk
      FOREIGN KEY (current_ordinary_instance_id)
      REFERENCES ordinary_work_order_instances(id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_current_ordinary_instance_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_ordinary_instance_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM ordinary_work_order_instances instance
      WHERE instance.id = NEW.current_ordinary_instance_id
        AND instance.work_order_id = NEW.id
    ) THEN
    RAISE EXCEPTION
      'ordinary instance % does not belong to work order %',
      NEW.current_ordinary_instance_id,
      NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_current_ordinary_instance_ownership ON work_orders;
CREATE TRIGGER trg_enforce_current_ordinary_instance_ownership
BEFORE INSERT OR UPDATE OF id, current_ordinary_instance_id
ON work_orders
FOR EACH ROW
EXECUTE FUNCTION enforce_current_ordinary_instance_ownership();

CREATE OR REPLACE FUNCTION sync_current_ordinary_instance_from_work_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_ordinary_instance_id IS NOT NULL THEN
    UPDATE ordinary_work_order_instances instance
    SET shop_id = NEW.shop_id,
      work_order_type = coalesce(
        nullif(NEW.payload->'manualOverrides'->>'workOrderType', ''),
        NEW.work_order_type,
        instance.work_order_type
      ),
      scenario_code = coalesce(
        nullif(NEW.payload->'manualOverrides'->>'scenarioCode', ''),
        NEW.scenario_code,
        instance.scenario_code,
        'unknown'
      ),
      status = NEW.status,
      runtime_status = coalesce(NEW.runtime_status, NEW.status),
      current_step = NEW.current_step,
      payload = coalesce(instance.payload, '{}'::jsonb) || coalesce(NEW.payload, '{}'::jsonb),
      manual_review_reason = NEW.manual_review_reason,
      next_attempt_at = NEW.next_attempt_at,
      completed_at = CASE
        WHEN NEW.status IN ('completed', 'archived', 'resolved')
          OR NEW.runtime_status IN ('completed', 'archived', 'resolved')
          THEN coalesce(instance.completed_at, NEW.completion_confirmed_at, NEW.updated_at, now())
        ELSE NULL
      END,
      completion_method = CASE
        WHEN NEW.status IN ('completed', 'archived', 'resolved')
          OR NEW.runtime_status IN ('completed', 'archived', 'resolved')
          THEN coalesce(NEW.completion_confirmation_method, instance.completion_method)
        ELSE NULL
      END,
      updated_at = now()
    WHERE instance.id = NEW.current_ordinary_instance_id
      AND instance.work_order_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_current_ordinary_instance ON work_orders;
CREATE TRIGGER trg_sync_current_ordinary_instance
AFTER UPDATE OF shop_id, work_order_type, scenario_code, status, runtime_status,
  current_step, payload, manual_review_reason, next_attempt_at,
  completion_confirmation_method, completion_confirmed_at,
  current_ordinary_instance_id
ON work_orders
FOR EACH ROW
EXECUTE FUNCTION sync_current_ordinary_instance_from_work_order();

ALTER TABLE external_effects ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE workflow_events ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE evidence_assets ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE manual_interventions ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE logistics_analyses ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE oms_analyses ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE tms_work_orders ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE verification_locations ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE operator_commands ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE classification_history ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;
ALTER TABLE data_corrections ADD COLUMN IF NOT EXISTS ordinary_instance_id uuid REFERENCES ordinary_work_order_instances(id) ON DELETE SET NULL;

ALTER TABLE external_effects
  DROP CONSTRAINT IF EXISTS external_effects_effect_type_check;
ALTER TABLE external_effects
  ADD CONSTRAINT external_effects_effect_type_check
  CHECK (effect_type IN (
    'oms-manual-allocation',
    'oms-reissue-create',
    'tms-create',
    'pdd-submit',
    'pdd-note',
    'pdd-return-refund',
    'evidence-upload'
  ));

CREATE OR REPLACE FUNCTION enforce_related_ordinary_instance_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ordinary_instance_id IS NOT NULL
    AND (
      NEW.work_order_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM ordinary_work_order_instances instance
        WHERE instance.id = NEW.ordinary_instance_id
          AND instance.work_order_id = NEW.work_order_id
      )
    ) THEN
    RAISE EXCEPTION
      'ordinary instance % does not belong to work order % for table %',
      NEW.ordinary_instance_id,
      NEW.work_order_id,
      TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  related_table text;
BEGIN
  FOREACH related_table IN ARRAY ARRAY[
    'external_effects',
    'workflow_events',
    'evidence_assets',
    'manual_interventions',
    'logistics_analyses',
    'oms_analyses',
    'tms_work_orders',
    'verification_locations',
    'audit_events',
    'operator_commands',
    'workflow_runs',
    'workflow_checkpoints',
    'classification_history',
    'data_corrections'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_enforce_ordinary_instance_ownership ON %I',
      related_table
    );
    EXECUTE format(
      'CREATE TRIGGER trg_enforce_ordinary_instance_ownership '
      || 'BEFORE INSERT OR UPDATE OF work_order_id, ordinary_instance_id ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION enforce_related_ordinary_instance_ownership()',
      related_table
    );
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_external_effects_ordinary_instance ON external_effects (ordinary_instance_id, effect_type);
CREATE INDEX IF NOT EXISTS idx_workflow_events_ordinary_instance ON workflow_events (ordinary_instance_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_assets_ordinary_instance ON evidence_assets (ordinary_instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_interventions_ordinary_instance ON manual_interventions (ordinary_instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tms_work_orders_ordinary_instance ON tms_work_orders (ordinary_instance_id, created_at DESC);

DROP INDEX IF EXISTS uq_logistics_analysis_source;
CREATE UNIQUE INDEX uq_logistics_analysis_source
  ON logistics_analyses (
    work_order_id,
    coalesce(ordinary_instance_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source_hash
  )
  WHERE source_hash IS NOT NULL;

DROP INDEX IF EXISTS uq_oms_analysis_source;
CREATE UNIQUE INDEX uq_oms_analysis_source
  ON oms_analyses (
    work_order_id,
    coalesce(ordinary_instance_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source_hash
  )
  WHERE source_hash IS NOT NULL;

ALTER TABLE tms_work_orders
  DROP CONSTRAINT IF EXISTS tms_work_orders_work_order_id_scenario_code_request_hash_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tms_work_order_instance_request
  ON tms_work_orders (
    work_order_id,
    coalesce(ordinary_instance_id, '00000000-0000-0000-0000-000000000000'::uuid),
    scenario_code,
    request_hash
  );

WITH legacy_source AS (
  SELECT work_order.*,
    coalesce(
      nullif(work_order.payload->>'detailUrl', ''),
      nullif(work_order.payload #>> '{latestDiscovery,detailUrl}', ''),
      nullif(work_order.payload #>> '{checkpoint,detailUrl}', '')
    ) AS candidate_detail_url
  FROM work_orders work_order
  WHERE work_order.scenario_code IS DISTINCT FROM 'return-refund'
), normalized AS (
  SELECT legacy_source.*,
    CASE
      WHEN candidate_detail_url ~* '^https://mms[.]pinduoduo[.]com/aftersales/work_order/tododetail/?[?]'
        THEN substring(candidate_detail_url FROM '[?&]id=([0-9]{6,30})(&|$)')
      ELSE NULL
    END AS platform_case_id
  FROM legacy_source
), ranked AS (
  SELECT normalized.*,
    CASE WHEN normalized.platform_case_id IS NOT NULL THEN
      row_number() OVER (
        PARTITION BY normalized.platform_case_id
        ORDER BY
          CASE WHEN normalized.frontend_visibility = 'operational' THEN 0 ELSE 1 END,
          CASE WHEN normalized.current_step IN (
            'owner-deleted', 'cross-shop-conflict', 'superseded-duplicate'
          ) THEN 1 ELSE 0 END,
          CASE WHEN normalized.idempotency_key LIKE 'pdd-discovered:%' THEN 0 ELSE 1 END,
          CASE WHEN normalized.completion_state = 'confirmed' THEN 0 ELSE 1 END,
          CASE WHEN normalized.status IN ('processing','queued','retry-ready') THEN 0 ELSE 1 END,
          normalized.updated_at DESC,
          normalized.created_at,
          normalized.id
      )
    END AS platform_case_rank,
    CASE WHEN normalized.platform_case_id IS NOT NULL THEN
      first_value(normalized.id) OVER (
        PARTITION BY normalized.platform_case_id
        ORDER BY
          CASE WHEN normalized.frontend_visibility = 'operational' THEN 0 ELSE 1 END,
          CASE WHEN normalized.current_step IN (
            'owner-deleted', 'cross-shop-conflict', 'superseded-duplicate'
          ) THEN 1 ELSE 0 END,
          CASE WHEN normalized.idempotency_key LIKE 'pdd-discovered:%' THEN 0 ELSE 1 END,
          CASE WHEN normalized.completion_state = 'confirmed' THEN 0 ELSE 1 END,
          CASE WHEN normalized.status IN ('processing','queued','retry-ready') THEN 0 ELSE 1 END,
          normalized.updated_at DESC,
          normalized.created_at,
          normalized.id
      )
    END AS authoritative_work_order_id
  FROM normalized
), inserted AS (
  INSERT INTO ordinary_work_order_instances (
    id, work_order_id, shop_id, platform_case_id, platform_case_key, detail_url,
    work_order_type, scenario_code, identity_status, status, runtime_status,
    current_step, payload, manual_review_reason, next_attempt_at,
    first_discovered_at, last_discovered_at, completed_at, completion_method,
    created_at, updated_at
  )
  SELECT gen_random_uuid(), ranked.id, ranked.shop_id,
    CASE WHEN ranked.platform_case_rank = 1 THEN ranked.platform_case_id ELSE NULL END,
    CASE WHEN ranked.platform_case_rank = 1
      THEN 'pdd-work-order:' || ranked.platform_case_id ELSE NULL END,
    ranked.candidate_detail_url,
    ranked.work_order_type,
    coalesce(ranked.scenario_code, 'unknown'),
    CASE WHEN ranked.platform_case_rank = 1 THEN 'verified' ELSE 'legacy-unverified' END,
    ranked.status,
    coalesce(ranked.runtime_status, ranked.status),
    ranked.current_step,
    coalesce(ranked.payload, '{}'::jsonb) || CASE
      WHEN coalesce(ranked.platform_case_rank, 1) > 1 THEN jsonb_build_object(
        'identityBackfillConflict', jsonb_build_object(
          'reason', 'duplicate-platform-case-id',
          'platformCaseId', ranked.platform_case_id,
          'platformCaseKey', 'pdd-work-order:' || ranked.platform_case_id,
          'authoritativeWorkOrderId', ranked.authoritative_work_order_id,
          'detectedAt', now()
        )
      )
      ELSE '{}'::jsonb
    END,
    ranked.manual_review_reason,
    ranked.next_attempt_at,
    ranked.created_at,
    ranked.updated_at,
    CASE WHEN ranked.status IN ('completed', 'archived') THEN ranked.updated_at ELSE NULL END,
    ranked.completion_confirmation_method,
    ranked.created_at,
    ranked.updated_at
  FROM ranked
  WHERE NOT EXISTS (
    SELECT 1 FROM ordinary_work_order_instances existing
    WHERE existing.work_order_id = ranked.id
  )
  RETURNING id, work_order_id
)
UPDATE work_orders work_order
SET current_ordinary_instance_id = inserted.id
FROM inserted
WHERE work_order.id = inserted.work_order_id
  AND work_order.current_ordinary_instance_id IS NULL;

INSERT INTO audit_events
  (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload, deduplication_key)
SELECT instance.shop_id, instance.work_order_id, instance.id, 'migration-059',
  'ordinary-instance-backfill-conflict',
  instance.payload->'identityBackfillConflict',
  'migration-059:ordinary-instance-conflict:' || instance.id::text
FROM ordinary_work_order_instances instance
WHERE instance.payload ? 'identityBackfillConflict'
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

UPDATE work_orders work_order
SET current_ordinary_instance_id = (
  SELECT ordinary.id
  FROM ordinary_work_order_instances ordinary
  WHERE ordinary.work_order_id = work_order.id
  ORDER BY ordinary.last_discovered_at DESC, ordinary.created_at DESC
  LIMIT 1
)
WHERE work_order.scenario_code IS DISTINCT FROM 'return-refund'
  AND work_order.current_ordinary_instance_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM ordinary_work_order_instances ordinary
    WHERE ordinary.work_order_id = work_order.id
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM work_orders work_order
    WHERE work_order.scenario_code IS DISTINCT FROM 'return-refund'
      AND work_order.current_ordinary_instance_id IS NULL
  ) THEN
    RAISE EXCEPTION 'migration 059 left an ordinary work order without an instance';
  END IF;
END;
$$;

UPDATE external_effects related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE workflow_events related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE evidence_assets related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE manual_interventions related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE logistics_analyses related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE oms_analyses related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE tms_work_orders related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE verification_locations related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE audit_events related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE operator_commands related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE workflow_runs related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE workflow_checkpoints related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE classification_history related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;
UPDATE data_corrections related SET ordinary_instance_id = work_order.current_ordinary_instance_id
FROM work_orders work_order WHERE related.work_order_id = work_order.id AND related.ordinary_instance_id IS NULL;

COMMIT;
