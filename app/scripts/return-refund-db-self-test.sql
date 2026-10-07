BEGIN;

DO $$
DECLARE
  shop_a text;
  shop_b text;
  duplicate_aftersale_rejected boolean := false;
  duplicate_order_rejected boolean := false;
BEGIN
  SELECT id INTO shop_a FROM shops
  WHERE id IN ('panapopo-healthcare', 'panapopo-medical-device')
  ORDER BY id LIMIT 1;
  SELECT id INTO shop_b FROM shops WHERE id <> shop_a ORDER BY id LIMIT 1;
  IF shop_a IS NULL OR shop_b IS NULL THEN
    RAISE EXCEPTION 'return-refund self-test requires two shops';
  END IF;

  IF EXISTS (SELECT 1 FROM shops
      WHERE enabled = true
        AND NOT ('return-refund' = ANY(scenario_codes))) THEN
    RAISE EXCEPTION 'return-refund scenario was not enabled for every enabled shop';
  END IF;
  IF coalesce((SELECT value FROM system_settings WHERE key = 'return-refund-auto-approve-enabled'), 'null'::jsonb) <> 'false'::jsonb THEN
    RAISE EXCEPTION 'automatic refund must remain disabled after migration';
  END IF;

  INSERT INTO work_orders
    (id, shop_id, external_order_number, work_order_type, scenario_code, status, idempotency_key)
  VALUES
    ('00000000-0000-4000-8000-000000000471', shop_a, '__return_refund_test_order__', '退货退款', 'return-refund', 'queued', '__return_refund_test_1__'),
    ('00000000-0000-4000-8000-000000000472', shop_a, '__return_refund_test_order__', '退货退款', 'return-refund', 'queued', '__return_refund_test_2__');

  INSERT INTO return_refunds
    (work_order_id, shop_id, external_order_number, aftersale_number)
  VALUES
    ('00000000-0000-4000-8000-000000000471', shop_a, '__return_refund_test_order__', '__aftersale_test_1__'),
    ('00000000-0000-4000-8000-000000000472', shop_a, '__return_refund_test_order__', '__aftersale_test_2__');

  INSERT INTO work_orders
    (id, shop_id, external_order_number, work_order_type, scenario_code, status, idempotency_key)
  VALUES
    ('00000000-0000-4000-8000-000000000473', shop_a, '__return_refund_test_order_2__', '退货退款', 'return-refund', 'queued', '__return_refund_test_3__');
  BEGIN
    INSERT INTO return_refunds
      (work_order_id, shop_id, external_order_number, aftersale_number)
    VALUES
      ('00000000-0000-4000-8000-000000000473', shop_a, '__return_refund_test_order_2__', '__aftersale_test_1__');
  EXCEPTION WHEN unique_violation THEN
    duplicate_aftersale_rejected := true;
  END;
  IF NOT duplicate_aftersale_rejected THEN
    RAISE EXCEPTION 'duplicate aftersale number was accepted';
  END IF;

  INSERT INTO work_orders
    (id, shop_id, external_order_number, work_order_type, scenario_code, status, idempotency_key)
  VALUES
    ('00000000-0000-4000-8000-000000000474', shop_a, '__ordinary_duplicate_test__', '普通工单测试', 'in-transit-refund', 'queued', '__ordinary_duplicate_test_1__');
  BEGIN
    INSERT INTO work_orders
      (id, shop_id, external_order_number, work_order_type, scenario_code, status, idempotency_key)
    VALUES
      ('00000000-0000-4000-8000-000000000475', shop_b, '__ordinary_duplicate_test__', '普通工单测试', 'in-transit-refund', 'queued', '__ordinary_duplicate_test_2__');
  EXCEPTION WHEN unique_violation THEN
    duplicate_order_rejected := true;
  END;
  IF NOT duplicate_order_rejected THEN
    RAISE EXCEPTION 'ordinary work-order global uniqueness was lost';
  END IF;

  INSERT INTO external_effects
    (id, shop_id, work_order_id, effect_type, idempotency_key, status, request_hash)
  VALUES
    ('00000000-0000-4000-8000-000000000476', shop_a,
     '00000000-0000-4000-8000-000000000471', 'pdd-return-refund',
     '__return_refund_effect_test__', 'reserved', '__return_refund_hash_test__');
END $$;

ROLLBACK;
