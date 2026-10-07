// List rows are hints, not terminal proof. These old archives may only be read
// back; a pending or uncertain detail must never authorize another submission.
export const LIST_COMPLETION_PROOF_EFFECT = 'pdd-list-completion-proof';

export async function claimUnverifiedListCompletion(pool, { shopId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      WITH candidate AS (
        SELECT w.id, i.id AS instance_id, i.platform_case_id, i.completed_at,
          binding.mall_id, binding.binding_token::text AS binding_token
        FROM work_orders w
        JOIN ordinary_work_order_instances i ON i.id = w.current_ordinary_instance_id
          AND i.work_order_id = w.id AND i.shop_id = w.shop_id
        JOIN shops s ON s.id = w.shop_id AND s.enabled = true
        JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = s.id
          AND binding.actual_shop_name = s.expected_shop_name
          AND binding.binding_token::text = w.payload #>> '{latestDiscovery,pddIdentityBindingToken}'
          AND binding.last_seen_at > now() - interval '2 minutes'
        JOIN shop_identity_bindings identity ON identity.shop_id = s.id
          AND identity.status = 'confirmed'
          AND identity.mall_id = binding.mall_id
          AND identity.profile_fingerprint = binding.profile_fingerprint
        WHERE w.shop_id = $1 AND w.completion_state = 'reconciliation-required'
          AND w.scenario_code <> 'consumer-address-change-in-transit'
          AND coalesce(w.payload #>> '{pddResolutionOutcomeMismatch,status}', '') <> 'manual-review-blocked'
          AND w.completion_confirmation_method = 'exact-order-completed'
          AND coalesce(w.frontend_visibility, 'operational') = 'operational'
          AND i.identity_status = 'verified' AND i.platform_case_id ~ '^[0-9]{6,30}$'
          AND i.platform_case_key = 'pdd-work-order:' || i.platform_case_id
          AND i.detail_url = 'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=' || i.platform_case_id
          AND (
            (w.status = 'archived' AND w.runtime_status = 'archived'
              AND i.status = 'archived' AND i.runtime_status = 'archived'
              AND NOT w.payload ? 'ordinaryListCompletionReadOnlyRecovery')
            OR (w.status = 'paused' AND w.recovery_state IN ('held', 'ready')
              AND i.status = 'paused' AND i.runtime_status IN ('paused', 'verification')
              AND w.current_step IN ('external-state-unresolved', 'human-verification-required',
                'external-state-reconciliation-ready')
              AND w.payload #>> '{ordinaryListCompletionReadOnlyRecovery,protectedReadOnly}' = 'true'
              AND w.recovery_updated_at < now() - interval '5 minutes'
              AND w.payload #>> '{ordinaryListCompletionReadOnlyRecovery,attempts}' = '1')
          )
          AND NOT EXISTS (SELECT 1 FROM external_effects e WHERE e.work_order_id = w.id
            AND (e.status <> 'succeeded' OR e.effect_type = 'pdd-submit'))
          AND NOT EXISTS (SELECT 1 FROM work_orders busy WHERE busy.shop_id = w.shop_id
            AND busy.runtime_status = 'processing')
          AND NOT EXISTS (SELECT 1 FROM return_refunds r WHERE r.shop_id = w.shop_id
            AND r.action_state = 'submitting')
          AND NOT EXISTS (SELECT 1 FROM verification_locations v WHERE v.shop_id = w.shop_id
            AND v.resolved_at IS NULL AND v.status IN ('detected', 'waiting-human', 'verification-required'))
          AND NOT EXISTS (SELECT 1 FROM shop_runtime_state runtime WHERE runtime.shop_id = w.shop_id
            AND runtime.current_work_order_id IS NOT NULL AND runtime.lease_expires_at > now())
        ORDER BY w.updated_at
        FOR UPDATE OF w, i SKIP LOCKED LIMIT 1
      )
      UPDATE work_orders w SET status = 'paused', runtime_status = 'processing',
        current_step = 'external-state-reconciling', recovery_state = 'reconciling',
        recovery_reason = 'list-completion-exact-detail-only',
        recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now(),
        payload = coalesce(w.payload, '{}'::jsonb) || jsonb_build_object(
          'ordinaryListCompletionReadOnlyRecovery', jsonb_build_object(
            'protectedReadOnly', true, 'externalActionsReplayed', false,
            'ordinaryInstanceId', candidate.instance_id,
            'platformWorkOrderId', candidate.platform_case_id,
            'mallId', candidate.mall_id, 'identityBindingToken', candidate.binding_token,
            'originalCompletedAt', coalesce(
              w.payload #>> '{ordinaryListCompletionReadOnlyRecovery,originalCompletedAt}',
              candidate.completed_at::text),
            'attempts', CASE WHEN w.payload ? 'ordinaryListCompletionReadOnlyRecovery' THEN 2 ELSE 1 END,
            'maxAttempts', 2, 'claimedAt', now()))
      FROM candidate WHERE w.id = candidate.id RETURNING w.*`, [shopId]);
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function completeListCompletionProof(pool, {
  workOrderId, shopId, ordinaryInstanceId, observation, payload = {},
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(`
      SELECT w.*, i.platform_case_id, i.platform_case_key,
        binding.mall_id, binding.binding_token::text AS binding_token
      FROM work_orders w
      JOIN ordinary_work_order_instances i ON i.id = w.current_ordinary_instance_id
        AND i.work_order_id = w.id AND i.shop_id = w.shop_id
      JOIN pdd_shop_runtime_bindings binding ON binding.shop_id = w.shop_id
      JOIN shops s ON s.id = w.shop_id AND s.enabled = true
        AND s.expected_shop_name = binding.actual_shop_name
      JOIN shop_identity_bindings identity ON identity.shop_id = w.shop_id
        AND identity.status = 'confirmed' AND identity.mall_id = binding.mall_id
        AND identity.profile_fingerprint = binding.profile_fingerprint
      WHERE w.id = $1 AND w.shop_id = $2 AND w.current_ordinary_instance_id = $3::uuid
        AND w.recovery_state = 'reconciling'
        AND w.completion_state = 'reconciliation-required'
        AND w.scenario_code <> 'consumer-address-change-in-transit'
        AND coalesce(w.payload #>> '{pddResolutionOutcomeMismatch,status}', '') <> 'manual-review-blocked'
        AND w.completion_confirmation_method = 'exact-order-completed'
        AND i.status = 'paused' AND i.runtime_status = 'processing' AND i.identity_status = 'verified'
        AND binding.last_seen_at > now() - interval '2 minutes'
        AND NOT EXISTS (SELECT 1 FROM external_effects e WHERE e.work_order_id = w.id
          AND (e.status <> 'succeeded' OR e.effect_type = 'pdd-submit'))
      FOR UPDATE OF w, i`, [workOrderId, shopId, ordinaryInstanceId]);
    const row = selected.rows[0], proof = payload.ordinaryListCompletionDetailProof;
    const guard = row?.payload?.ordinaryListCompletionReadOnlyRecovery;
    const at = Date.parse(observation?.observedAt || '');
    if (!row || guard?.protectedReadOnly !== true
      || guard.ordinaryInstanceId !== ordinaryInstanceId
      || String(guard.platformWorkOrderId) !== row.platform_case_id
      || guard.identityBindingToken !== row.binding_token
      || guard.mallId !== row.mall_id
      || observation?.effectType !== LIST_COMPLETION_PROOF_EFFECT
      || observation.state !== 'confirmed' || observation.readOnly !== true
      || observation.externalActionsReplayed !== false
      || observation.orderNumber !== row.external_order_number
      || observation.ordinaryInstanceId !== ordinaryInstanceId
      || observation.observedPlatformWorkOrderId !== row.platform_case_id
      || observation.observedMallId !== row.mall_id
      || observation.confirmationMethod !== 'detail-completed'
      || !Number.isFinite(at) || at > Date.now() + 5000 || Date.now() - at > 120_000
      || proof?.confirmed !== true || proof.orderNumber !== row.external_order_number
      || proof.observedPlatformWorkOrderId !== row.platform_case_id
      || proof.platformCompletionObservation?.platformCaseMatches !== true) {
      throw new Error('list-completion-read-only-exact-proof-required');
    }
    const durable = { ...payload,
      latestDiscovery: row.payload.latestDiscovery,
      ordinaryListCompletionReadOnlyRecovery: { ...guard, confirmedAt: observation.observedAt },
      externalStateReconciliation: observation };
    const result = await client.query(`
      UPDATE work_orders SET status = 'archived', runtime_status = 'archived',
        current_step = 'external-state-confirmed', completion_state = 'confirmed',
        completion_confirmation_method = 'detail-completed', completion_confirmed_at = $3::timestamptz,
        payload = $4::jsonb, manual_review_reason = NULL, next_attempt_at = NULL,
        recovery_state = 'ready', recovery_reason = NULL,
        recovery_version = recovery_version + 1, recovery_updated_at = now(), updated_at = now()
      WHERE id = $1 AND shop_id = $2 RETURNING *`,
    [workOrderId, shopId, observation.observedAt, JSON.stringify(durable)]);
    await client.query(`UPDATE ordinary_work_order_instances SET
      current_step = 'external-state-confirmed', completion_method = 'detail-completed',
      payload = $3::jsonb, completed_at = coalesce($4::timestamptz, completed_at), updated_at = now()
      WHERE id = $1 AND work_order_id = $2`,
    [ordinaryInstanceId, workOrderId, JSON.stringify(durable), guard.originalCompletedAt]);
    await client.query(`INSERT INTO audit_events
      (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload)
      VALUES ($1,$2,$3,'worker-read-only-reconciliation','list-completion-detail-confirmed',$4::jsonb)`,
    [shopId, workOrderId, ordinaryInstanceId, JSON.stringify(observation)]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
