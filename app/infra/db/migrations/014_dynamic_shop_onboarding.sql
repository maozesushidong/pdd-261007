BEGIN;

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS expected_shop_name text,
  ADD COLUMN IF NOT EXISTS work_order_title text NOT NULL DEFAULT '订单问题：在途无理由退款处理',
  ADD COLUMN IF NOT EXISTS scenario_codes text[] NOT NULL DEFAULT ARRAY[
    'in-transit-refund',
    'shipped-no-tracking-refund',
    'abnormal-network-warning'
  ]::text[],
  ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS onboarding_error text,
  ADD COLUMN IF NOT EXISTS login_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;

UPDATE shops
SET expected_shop_name = CASE id
    WHEN 'panapopo-healthcare' THEN 'PANAPOPO医疗保健官方旗舰店林动'
    WHEN 'panapopo-medical-device' THEN 'PANAPOPO医疗器械官方旗舰店梦蝶'
    WHEN 'songteng-yazc-overseas' THEN '松藤Yazc海外好物馆林动'
    ELSE name
  END,
  onboarding_status = CASE WHEN enabled THEN 'ready' ELSE 'disabled' END,
  onboarding_completed_at = CASE WHEN enabled THEN coalesce(onboarding_completed_at, updated_at) ELSE onboarding_completed_at END
WHERE expected_shop_name IS NULL;

ALTER TABLE shops
  ALTER COLUMN expected_shop_name SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'shops'::regclass
      AND conname = 'shops_onboarding_status_check'
  ) THEN
    ALTER TABLE shops ADD CONSTRAINT shops_onboarding_status_check
      CHECK (onboarding_status IN ('waiting-login', 'initializing', 'ready', 'identity-mismatch', 'error', 'disabled'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_expected_name_unique
  ON shops (lower(expected_shop_name));
CREATE INDEX IF NOT EXISTS idx_shops_worker_desired
  ON shops (enabled, onboarding_status, updated_at);

COMMIT;
