import crypto from 'node:crypto';
import { nextOrdinaryScanAt, schedulerDefaults } from './scheduler-policy.mjs';

const json = (value) => JSON.stringify(value ?? {});
const activeSlotStates = ['starting', 'running', 'draining'];

const ordinaryIdentityMatchesCurrentBindingSql = (alias) => `
  AND (
    NOT EXISTS (
      SELECT 1 FROM pdd_shop_runtime_bindings binding
      WHERE binding.shop_id = ${alias}.shop_id
    )
    OR ${alias}.payload->'latestDiscovery'->>'pddIdentityBindingToken' = (
      SELECT binding.binding_token::text
      FROM pdd_shop_runtime_bindings binding
      WHERE binding.shop_id = ${alias}.shop_id
    )
  )`;

const ordinaryRecoverySql = (alias) => `
  ${alias}.scenario_code IS DISTINCT FROM 'return-refund'
  AND ${alias}.status = 'processing'
  AND ${alias}.recovery_state <> 'held'
  ${ordinaryIdentityMatchesCurrentBindingSql(alias)}`;

const ordinaryClaimableSql = (alias) => `
  ${alias}.scenario_code IS DISTINCT FROM 'return-refund'
  AND ${alias}.status IN ('queued', 'retry-ready')
  AND ${alias}.recovery_state IN ('ready', 'retry-authorized')
  AND (${alias}.next_attempt_at IS NULL OR ${alias}.next_attempt_at <= now())
  ${ordinaryIdentityMatchesCurrentBindingSql(alias)}`;

const refundClaimableSql = (alias) => `
  ${alias}.scenario_code = 'return-refund'
  AND ${alias}.recovery_state IN ('ready', 'retry-authorized')
  AND (${alias}.next_attempt_at IS NULL OR ${alias}.next_attempt_at <= now())
  AND (
    ${alias}.status IN ('queued', 'retry-ready')
    OR (${alias}.status = 'paused' AND EXISTS (
      SELECT 1 FROM return_refunds manual_refund
      WHERE manual_refund.work_order_id = ${alias}.id
        AND manual_refund.action_state = 'manual-review'
        AND coalesce(
          manual_refund.next_check_at,
          manual_refund.last_scanned_at + interval '30 minutes',
          '-infinity'::timestamptz
        ) <= now()
    ))
  )
  AND EXISTS (
    SELECT 1 FROM return_refunds refund
    WHERE refund.work_order_id = ${alias}.id
      AND (
        refund.action_state = 'ready'
        OR (refund.action_state = 'waiting-logistics'
          AND refund.next_check_at IS NOT NULL
          AND refund.next_check_at <= now())
        OR (refund.action_state = 'page-error'
          AND ${alias}.status = 'retry-ready')
        OR (refund.action_state = 'verification-required'
          AND refund.next_check_at IS NOT NULL
          AND refund.next_check_at <= now())
        OR (refund.action_state = 'verification-required' AND EXISTS (
          SELECT 1 FROM external_effects refund_effect
          WHERE refund_effect.work_order_id = ${alias}.id
            AND refund_effect.effect_type = 'pdd-return-refund'
            AND refund_effect.status IN ('reserved', 'unknown')
        ))
        OR (refund.action_state = 'manual-review'
          AND coalesce(
            refund.next_check_at,
            refund.last_scanned_at + interval '30 minutes',
            '-infinity'::timestamptz
          ) <= now())
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM pdd_shop_runtime_bindings binding
          WHERE binding.shop_id = ${alias}.shop_id
        )
        OR refund.evidence->>'pddIdentityBindingToken' = (
          SELECT binding.binding_token::text
          FROM pdd_shop_runtime_bindings binding
          WHERE binding.shop_id = ${alias}.shop_id
        )
      )
  )`;

const candidateSql = ({ lock = true, limit = 1 } = {}) => `
  WITH eligible AS (
    SELECT schedule.shop_id,
      schedule.queue_entered_at,
      schedule.next_ordinary_scan_at,
      schedule.next_refund_scan_at,
      shop.login_requested_at,
      EXISTS (
        SELECT 1 FROM verification_locations verification
        WHERE verification.shop_id = schedule.shop_id
          AND verification.status IN ('detected', 'waiting-human', 'verification-required')
          AND verification.resolved_at IS NULL
      ) AS verification_waiting,
      EXISTS (
        SELECT 1 FROM work_orders work_order
        WHERE work_order.shop_id = schedule.shop_id
          AND ${ordinaryRecoverySql('work_order')}
      ) AS recovery_waiting,
      EXISTS (
        SELECT 1 FROM work_orders work_order
        WHERE work_order.shop_id = schedule.shop_id
          AND ${ordinaryClaimableSql('work_order')}
      ) AS ordinary_waiting,
      EXISTS (
        SELECT 1 FROM work_orders work_order
        WHERE work_order.shop_id = schedule.shop_id
          AND ${refundClaimableSql('work_order')}
      ) AS refund_waiting,
      schedule.metadata->>'manualSessionKind' AS manual_session_kind,
      CASE
        WHEN shop.onboarding_status = 'ready' AND EXISTS (
          SELECT 1 FROM work_orders work_order
          WHERE work_order.shop_id = schedule.shop_id
            AND ${ordinaryRecoverySql('work_order')}
        ) THEN 'recovery'
        WHEN EXISTS (
          SELECT 1 FROM verification_locations verification
          WHERE verification.shop_id = schedule.shop_id
            AND verification.status IN ('detected', 'waiting-human', 'verification-required')
            AND verification.resolved_at IS NULL
        ) THEN 'verification'
        WHEN schedule.metadata->>'manualSessionKind' = 'login'
          OR (shop.login_requested_at IS NOT NULL
            AND shop.login_requested_at > coalesce(schedule.last_login_request_at, '-infinity'::timestamptz))
          THEN 'login'
        WHEN $3::boolean AND shop.onboarding_status IS DISTINCT FROM 'ready' THEN 'login'
        WHEN shop.onboarding_status = 'ready'
          AND schedule.metadata->>'manualSessionKind' = 'business' THEN 'ordinary'
        WHEN shop.onboarding_status = 'ready' AND EXISTS (
          SELECT 1 FROM work_orders work_order
          WHERE work_order.shop_id = schedule.shop_id
            AND ${ordinaryClaimableSql('work_order')}
        ) THEN 'ordinary'
        WHEN shop.onboarding_status = 'ready' AND EXISTS (
          SELECT 1 FROM work_orders work_order
          WHERE work_order.shop_id = schedule.shop_id
            AND ${refundClaimableSql('work_order')}
        ) THEN 'refund-execution'
        WHEN shop.onboarding_status = 'ready'
          AND schedule.next_ordinary_scan_at <= now() THEN 'ordinary'
        WHEN shop.onboarding_status = 'ready' AND $3::boolean THEN 'ordinary'
        ELSE 'refund-scan'
      END AS assignment_kind
    FROM shop_schedule_state schedule
    JOIN shops shop ON shop.id = schedule.shop_id
    WHERE shop.enabled = true
      AND schedule.assigned_slot_id IS NULL
      AND schedule.schedule_state <> 'disabled'
      AND NOT EXISTS (
        SELECT 1 FROM shop_runtime_state runtime
        WHERE runtime.shop_id = schedule.shop_id
          AND runtime.current_work_order_id IS NOT NULL
          AND runtime.lease_token IS NOT NULL
          AND runtime.lease_expires_at > now()
      )
      AND ($2::text[] IS NULL OR schedule.shop_id = ANY($2::text[]))
      AND coalesce(schedule.retry_at, '-infinity'::timestamptz) <= now()
      AND (
        $3::boolean
        OR EXISTS (
          SELECT 1 FROM verification_locations verification
          WHERE verification.shop_id = schedule.shop_id
            AND verification.status IN ('detected', 'waiting-human', 'verification-required')
            AND verification.resolved_at IS NULL
        )
        OR schedule.metadata->>'manualSessionKind' = 'login'
        OR (shop.login_requested_at IS NOT NULL
          AND shop.login_requested_at > coalesce(schedule.last_login_request_at, '-infinity'::timestamptz))
        OR (shop.onboarding_status = 'ready' AND (
          $3::boolean
          OR schedule.metadata->>'manualSessionKind' = 'business'
          OR schedule.next_ordinary_scan_at <= now()
          OR schedule.next_refund_scan_at <= now()
          OR EXISTS (
            SELECT 1 FROM work_orders work_order
            WHERE work_order.shop_id = schedule.shop_id
              AND (
                (${ordinaryRecoverySql('work_order')})
                OR (${ordinaryClaimableSql('work_order')})
                OR (${refundClaimableSql('work_order')})
              )
          )
        ))
      )
  ), ranked AS (
    SELECT eligible.*,
      CASE assignment_kind
        WHEN 'recovery' THEN 0
        WHEN 'verification' THEN 1
        WHEN 'login' THEN 2
        WHEN 'ordinary' THEN 3
        WHEN 'refund-execution' THEN 4
        ELSE 5
      END AS priority,
      CASE assignment_kind
        WHEN 'refund-scan' THEN next_refund_scan_at
        ELSE next_ordinary_scan_at
      END AS due_at
    FROM eligible
    WHERE assignment_kind = ANY($1::text[])
  )
  SELECT ranked.*, schedule.heat_state, schedule.hot_until,
    schedule.refund_scan_cursor, schedule.refund_scan_in_progress,
    shop.display_slot, shop.config_version
  FROM ranked
  JOIN shop_schedule_state schedule ON schedule.shop_id = ranked.shop_id
  JOIN shops shop ON shop.id = ranked.shop_id
  ORDER BY greatest(0, ranked.priority - floor(extract(epoch FROM (now() - ranked.queue_entered_at)) / 600)::int),
    ranked.due_at,
    ranked.queue_entered_at, ranked.shop_id
  LIMIT ${Math.max(1, Number(limit) || 1)}
  ${lock ? 'FOR UPDATE OF schedule SKIP LOCKED' : ''}`;

export class ShopSchedulerRepository {
  constructor(pool, { config = schedulerDefaults, supervisorId = `scheduler-${process.pid}` } = {}) {
    this.pool = pool;
    this.config = config;
    this.supervisorId = supervisorId;
  }

  async initialize() {
    await this.pool.query(`
      INSERT INTO shop_schedule_state (
        shop_id, heat_state, hot_until, next_ordinary_scan_at, next_refund_scan_at,
        schedule_state
      )
      SELECT id, 'hot', now() + interval '2 hours', now(), now(),
        CASE WHEN enabled THEN 'queued' ELSE 'disabled' END
      FROM shops ON CONFLICT (shop_id) DO NOTHING`);
    await this.pool.query(`
      UPDATE shop_schedule_state schedule SET retry_at = NULL,
        schedule_state = 'queued',
        queue_entered_at = least(coalesce(schedule.queue_entered_at, now()), now()),
        updated_at = now(), version = version + 1
      FROM shops shop
      WHERE shop.id = schedule.shop_id AND shop.enabled = true
        AND schedule.assigned_slot_id IS NULL AND schedule.retry_at IS NOT NULL`);
    await this.recoverExpiredAssignments();
  }

  async recoverExpiredAssignments() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const expired = await client.query(`
        SELECT shop_id, assigned_slot_id, assignment_kind
        FROM shop_schedule_state
        WHERE assigned_slot_id IS NOT NULL AND assignment_expires_at < now()
        FOR UPDATE SKIP LOCKED`);
      for (const row of expired.rows) {
        await client.query(`
          UPDATE browser_slots SET state = 'stopped', draining = false,
            metadata = metadata || jsonb_build_object('expiredAt', now()), updated_at = now()
          WHERE id = $1`, [row.assigned_slot_id]);
        await client.query(`
          UPDATE shop_schedule_state SET assigned_slot_id = NULL, assignment_token = NULL,
            assignment_kind = NULL, assignment_started_at = NULL, assignment_expires_at = NULL,
            schedule_state = 'queued', queue_entered_at = least(queue_entered_at, now()),
            retry_at = now(), failure_count = failure_count + 1,
            last_failure = 'slot-lease-expired', updated_at = now(), version = version + 1
          WHERE shop_id = $1`, [row.shop_id]);
      }
      await client.query('COMMIT');
      return expired.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverOrphanedAssignments(slotIds = []) {
    const ids = [...new Set(slotIds.filter(Boolean))];
    if (!ids.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const orphaned = await client.query(`
        SELECT schedule.shop_id, schedule.assigned_slot_id
        FROM shop_schedule_state schedule
        JOIN browser_slots slot ON slot.id = schedule.assigned_slot_id
        WHERE schedule.assigned_slot_id = ANY($1::uuid[])
          AND slot.state <> 'stopped' AND slot.external_effect_active = false
        FOR UPDATE OF schedule SKIP LOCKED`, [ids]);
      const recoveredIds = orphaned.rows.map((row) => row.assigned_slot_id);
      if (recoveredIds.length) {
        await client.query(`
          UPDATE browser_slots SET state = 'stopped', draining = false,
            metadata = metadata || jsonb_build_object('orphanedAt', now()), updated_at = now()
          WHERE id = ANY($1::uuid[])`, [recoveredIds]);
        await client.query(`
          UPDATE shop_schedule_state SET assigned_slot_id = NULL, assignment_token = NULL,
            assignment_kind = NULL, assignment_started_at = NULL, assignment_expires_at = NULL,
            schedule_state = 'queued', queue_entered_at = least(queue_entered_at, now()),
            retry_at = NULL, last_failure = 'slot-process-missing',
            updated_at = now(), version = version + 1
          WHERE assigned_slot_id = ANY($1::uuid[])`, [recoveredIds]);
      }
      await client.query('COMMIT');
      return orphaned.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshot() {
    const result = await this.pool.query(`
      SELECT
        count(*) FILTER (WHERE shop.enabled)::int AS enabled_shops,
        count(*) FILTER (WHERE shop.enabled
          AND schedule.assigned_slot_id IS NULL)::int AS unassigned_enabled_shops,
        count(*) FILTER (WHERE shop.enabled AND schedule.hot_until > now())::int AS hot_shops,
        count(*) FILTER (WHERE shop.enabled AND schedule.hot_until <= now())::int AS cold_shops,
        count(DISTINCT shop.id) FILTER (WHERE shop.enabled
          AND (
            EXISTS (
              SELECT 1 FROM verification_locations verification
              WHERE verification.shop_id = shop.id
                AND verification.status IN ('detected','waiting-human','verification-required')
                AND verification.resolved_at IS NULL
            )
            OR schedule.metadata->>'manualSessionKind' = 'login'
            OR (shop.login_requested_at IS NOT NULL
              AND shop.login_requested_at > coalesce(schedule.last_login_request_at, '-infinity'::timestamptz))
            OR shop.onboarding_status IS DISTINCT FROM 'ready'
            OR (shop.onboarding_status = 'ready'
              AND (
                schedule.next_ordinary_scan_at <= now()
                OR schedule.next_refund_scan_at <= now()
                OR EXISTS (
                  SELECT 1 FROM work_orders work_order
                  WHERE work_order.shop_id = shop.id
                    AND work_order.status IN ('processing','queued','retry-ready')
                    AND coalesce(work_order.next_attempt_at, now()) <= now()
                )
              ))
          ))::int AS due_shops,
        count(DISTINCT shop.id) FILTER (WHERE shop.enabled
          AND schedule.assigned_slot_id IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM verification_locations verification
              WHERE verification.shop_id = shop.id
                AND verification.status IN ('detected','waiting-human','verification-required')
                AND verification.resolved_at IS NULL
            )
            OR schedule.metadata->>'manualSessionKind' = 'login'
            OR (shop.login_requested_at IS NOT NULL
              AND shop.login_requested_at > coalesce(schedule.last_login_request_at, '-infinity'::timestamptz))
            OR shop.onboarding_status IS DISTINCT FROM 'ready'
            OR (shop.onboarding_status = 'ready'
              AND (
                schedule.next_ordinary_scan_at <= now()
                OR schedule.next_refund_scan_at <= now()
                OR EXISTS (
                  SELECT 1 FROM work_orders work_order
                  WHERE work_order.shop_id = shop.id
                    AND work_order.status IN ('processing','queued','retry-ready')
                    AND coalesce(work_order.next_attempt_at, now()) <= now()
                )
              ))
          ))::int AS unassigned_due_shops,
        count(DISTINCT shop.id) FILTER (WHERE shop.enabled
          AND schedule.next_ordinary_scan_at < now() - CASE
            WHEN schedule.hot_until > now() THEN interval '2 minutes' ELSE interval '10 minutes' END)::int
          AS overdue_shops,
        count(*) FILTER (WHERE slot.state = ANY($1::text[])
          AND slot.lease_expires_at > now())::int AS active_slots,
        count(*) FILTER (WHERE slot.state = ANY($1::text[])
          AND slot.lease_expires_at > now() AND slot.kind = 'business')::int AS business_slots,
        count(*) FILTER (WHERE slot.state = ANY($1::text[])
          AND slot.lease_expires_at > now() AND slot.kind = 'verification')::int AS verification_slots,
        count(*) FILTER (WHERE slot.state = ANY($1::text[])
          AND slot.lease_expires_at > now() AND slot.kind = 'login')::int AS login_slots,
        coalesce(jsonb_agg(slot.memory_mb) FILTER (WHERE slot.memory_mb IS NOT NULL
          AND slot.state = ANY($1::text[])
          AND slot.lease_expires_at > now()), '[]'::jsonb) AS slot_memory_samples
      FROM shops shop
      JOIN shop_schedule_state schedule ON schedule.shop_id = shop.id
      LEFT JOIN browser_slots slot ON slot.shop_id = shop.id AND slot.state = ANY($1::text[])`,
    [activeSlotStates]);
    const row = result.rows[0] || {};
    return {
      enabledShops: Number(row.enabled_shops || 0),
      unassignedEnabledShops: Number(row.unassigned_enabled_shops || 0),
      hotShops: Number(row.hot_shops || 0),
      coldShops: Number(row.cold_shops || 0),
      dueShops: Number(row.due_shops || 0),
      unassignedDueShops: Number(row.unassigned_due_shops || 0),
      overdueShops: Number(row.overdue_shops || 0),
      activeSlots: Number(row.active_slots || 0),
      businessSlots: Number(row.business_slots || 0),
      verificationSlots: Number(row.verification_slots || 0),
      loginSlots: Number(row.login_slots || 0),
      slotMemorySamplesMb: Array.isArray(row.slot_memory_samples)
        ? row.slot_memory_samples.map(Number).filter(Number.isFinite) : [],
    };
  }

  allowedKinds(snapshot) {
    const kinds = ['recovery', 'ordinary', 'refund-execution', 'refund-scan'];
    if (this.config.capacityMode === 'unbounded'
      || snapshot.verificationSlots < this.config.verificationSlots) kinds.push('verification');
    if (this.config.capacityMode === 'unbounded' || snapshot.loginSlots < this.config.loginSlots) kinds.push('login');
    return kinds;
  }

  async peek({ limit = 100, shopIds = null, allowedKinds = Object.keys({
    recovery: 1, verification: 1, login: 1, ordinary: 1,
    'refund-execution': 1, 'refund-scan': 1,
  }) } = {}) {
    const result = await this.pool.query(candidateSql({ lock: false, limit }), [
      allowedKinds, shopIds, this.config.keepEnabledShopsResident,
    ]);
    return result.rows;
  }

  async claim({ allowedKinds, shopIds = null, sessionDurations = {} }) {
    const client = await this.pool.connect();
    try {
      // The partial unique indexes are the final fence if two PostgreSQL
      // snapshots rank the same shop or slot before either transaction commits.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await client.query('BEGIN');
        const candidate = await client.query(candidateSql({ lock: true }), [
          allowedKinds, shopIds, this.config.keepEnabledShopsResident,
        ]);
        const row = candidate.rows[0];
        if (!row) {
          await client.query('COMMIT');
          return null;
        }
        const slotResult = await client.query(`
          WITH active AS (
            SELECT slot_index FROM browser_slots WHERE state <> 'stopped'
          ), candidates AS (
            SELECT generate_series(
              0,
              CASE WHEN $1::int IS NULL
                THEN (SELECT count(*)::int FROM active)
                ELSE greatest(0, $1::int - 1)
              END
            ) AS slot_index
          )
          SELECT candidate.slot_index
          FROM candidates candidate
          WHERE NOT EXISTS (
            SELECT 1 FROM active slot WHERE slot.slot_index = candidate.slot_index
          )
          ORDER BY candidate.slot_index LIMIT 1`, [this.config.hardSlotLimit ?? null]);
        if (!slotResult.rowCount) {
          await client.query('ROLLBACK');
          return null;
        }
        const slotKind = row.assignment_kind === 'verification' ? 'verification'
          : row.assignment_kind === 'login' ? 'login' : 'business';
        const sessionMs = sessionDurations[slotKind]
          || (slotKind === 'verification' ? this.config.verificationSessionMs
            : slotKind === 'login' ? this.config.loginSessionMs : this.config.businessSessionMs);
        const slotId = crypto.randomUUID();
        const leaseToken = crypto.randomUUID();
        const leaseExpiresAt = new Date(Date.now() + sessionMs + 5 * 60_000);
        const inserted = await client.query(`
          INSERT INTO browser_slots (
            id, slot_index, kind, state, shop_id, lease_token, lease_expires_at, metadata
          ) VALUES ($1,$2,$3,'starting',$4,$5,$6,$7::jsonb)
          ON CONFLICT DO NOTHING RETURNING id`, [
          slotId, slotResult.rows[0].slot_index, slotKind, row.shop_id,
          leaseToken, leaseExpiresAt, json({ supervisorId: this.supervisorId, assignmentKind: row.assignment_kind }),
        ]);
        if (!inserted.rowCount) {
          await client.query('ROLLBACK');
          continue;
        }
        const reserved = await client.query(`
          UPDATE shop_schedule_state SET schedule_state = $2, assignment_kind = $3,
            assigned_slot_id = $4, assignment_token = $5, assignment_started_at = now(),
            assignment_expires_at = $6, last_login_request_at = CASE
              WHEN $3 = 'login' THEN coalesce(
                (SELECT login_requested_at FROM shops WHERE id = $1),
                now()
              ) ELSE last_login_request_at END,
            metadata = metadata - 'manualSessionKind', updated_at = now(), version = version + 1
          WHERE shop_id = $1 AND assigned_slot_id IS NULL
          RETURNING shop_id`, [
          row.shop_id,
          slotKind === 'verification' ? 'verification' : slotKind === 'login' ? 'login' : 'running',
          row.assignment_kind, slotId, leaseToken, leaseExpiresAt,
        ]);
        if (!reserved.rowCount) {
          await client.query('ROLLBACK');
          continue;
        }
        await client.query('COMMIT');
        return {
          shopId: row.shop_id,
          displaySlot: Number(row.display_slot),
          assignmentKind: row.assignment_kind,
          slotKind,
          slotId,
          slotIndex: Number(slotResult.rows[0].slot_index),
          leaseToken,
          leaseExpiresAt,
          sessionMs,
          refundScanCursor: row.refund_scan_cursor || { page: 1, itemOffset: 0 },
          refundScanInProgress: Boolean(row.refund_scan_in_progress),
        };
      }
      return null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async markSlotRunning({ slotId, leaseToken, processId }) {
    const result = await this.pool.query(`
      UPDATE browser_slots SET state = 'running', process_id = $3,
        browser_started_at = coalesce(browser_started_at, now()), heartbeat_at = now(), updated_at = now()
      WHERE id = $1 AND lease_token = $2 AND state = 'starting'
      RETURNING id`, [slotId, leaseToken, processId || null]);
    return Boolean(result.rowCount);
  }

  async heartbeat({
    slotId,
    leaseToken,
    memoryMb = null,
    cpuPercent = null,
    externalEffectActive = false,
    leaseExtensionMs = 0,
  }) {
    const result = await this.pool.query(`
      UPDATE browser_slots SET heartbeat_at = now(), memory_mb = coalesce($3, memory_mb),
        cpu_percent = coalesce($4, cpu_percent), external_effect_active = $5,
        lease_expires_at = CASE WHEN $6::bigint > 0
          THEN greatest(lease_expires_at, now() + ($6::bigint * interval '1 millisecond'))
          WHEN $5 THEN greatest(lease_expires_at, now() + interval '15 minutes')
          ELSE lease_expires_at END,
        updated_at = now()
      WHERE id = $1 AND lease_token = $2 AND state <> 'stopped'
      RETURNING shop_id, lease_expires_at, lease_expires_at > now() AS valid`,
    [slotId, leaseToken, memoryMb, cpuPercent, externalEffectActive, Math.max(0, Number(leaseExtensionMs) || 0)]);
    if ((externalEffectActive || leaseExtensionMs > 0) && result.rows[0]?.shop_id) {
      await this.pool.query(`
        UPDATE shop_schedule_state SET assignment_expires_at = greatest(
          assignment_expires_at, $3::timestamptz
        ), updated_at = now()
        WHERE shop_id = $1 AND assignment_token = $2`,
      [result.rows[0].shop_id, leaseToken, result.rows[0].lease_expires_at]);
    }
    return Boolean(result.rows[0]?.valid);
  }

  async transitionResidentSlot({
    shopId,
    slotId,
    leaseToken,
    slotKind,
    assignmentKind,
    leaseExtensionMs = 15 * 60_000,
  }) {
    const scheduleState = slotKind === 'verification' ? 'verification'
      : slotKind === 'login' ? 'login' : 'running';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const slot = await client.query(`
        UPDATE browser_slots SET kind = $4, state = 'running', heartbeat_at = now(),
          lease_expires_at = greatest(
            lease_expires_at,
            now() + ($6::bigint * interval '1 millisecond')
          ),
          metadata = metadata || jsonb_build_object(
            'assignmentKind', $5::text,
            'transitionedAt', now()
          ),
          updated_at = now()
        WHERE id = $1::uuid AND shop_id = $2 AND lease_token = $3::uuid
          AND state <> 'stopped'
        RETURNING lease_expires_at`, [
        slotId, shopId, leaseToken, slotKind, assignmentKind,
        Math.max(60_000, Number(leaseExtensionMs) || 0),
      ]);
      if (!slot.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      const schedule = await client.query(`
        UPDATE shop_schedule_state SET schedule_state = $4, assignment_kind = $5,
          assignment_expires_at = greatest(assignment_expires_at, $6::timestamptz),
          retry_at = NULL, updated_at = now(), version = version + 1
        WHERE shop_id = $1 AND assigned_slot_id = $2::uuid
          AND assignment_token = $3::uuid
        RETURNING shop_id`, [
        shopId, slotId, leaseToken, scheduleState, assignmentKind,
        slot.rows[0].lease_expires_at,
      ]);
      if (!schedule.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recordOrdinaryScan({ shopId, leaseToken, outcome = 'completed', retryAt = null }) {
    const parsedRetryAt = retryAt ? new Date(retryAt) : null;
    const normalizedRetryAt = parsedRetryAt && Number.isFinite(parsedRetryAt.getTime())
      ? parsedRetryAt : null;
    const hotOrdinaryIntervalMs = Number.isFinite(Number(this.config.hotOrdinaryIntervalMs))
      ? Number(this.config.hotOrdinaryIntervalMs) : schedulerDefaults.hotOrdinaryIntervalMs;
    const coldOrdinaryIntervalMs = Number.isFinite(Number(this.config.coldOrdinaryIntervalMs))
      ? Number(this.config.coldOrdinaryIntervalMs) : schedulerDefaults.coldOrdinaryIntervalMs;
    const result = await this.pool.query(`
      UPDATE shop_schedule_state SET
        last_ordinary_scan_at = now(),
        next_ordinary_scan_at = CASE
          WHEN $4::timestamptz IS NOT NULL THEN greatest(now(), $4::timestamptz)
          WHEN $3 = 'verification-required' THEN now() + interval '10 minutes'
          WHEN $3 = 'rate-limited' THEN now() + interval '10 minutes'
          WHEN $3 = 'retryable-error' THEN now() + interval '2 minutes'
          WHEN hot_until > now() THEN now() + ($5::bigint * interval '1 millisecond')
          ELSE now() + ($6::bigint * interval '1 millisecond')
        END,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'lastOrdinaryScanOutcome', $3::text,
          'lastOrdinaryScanRecordedAt', now()
        ),
        updated_at = now(), version = version + 1
      WHERE shop_id = $1 AND assignment_token = $2
      RETURNING shop_id, next_ordinary_scan_at`, [
      shopId,
      leaseToken,
      String(outcome || 'completed'),
      normalizedRetryAt,
      hotOrdinaryIntervalMs,
      coldOrdinaryIntervalMs,
    ]);
    return result.rows[0] || null;
  }

  async recordRefundCursor({ shopId, leaseToken, cursor, fullScanCompleted, totals = {} }) {
    const normalized = {
      page: Math.max(1, Math.floor(Number(cursor?.page) || 1)),
      itemOffset: Math.max(0, Math.floor(Number(cursor?.itemOffset) || 0)),
    };
    const result = await this.pool.query(`
      UPDATE shop_schedule_state SET refund_scan_cursor = $3::jsonb,
        refund_scan_in_progress = NOT $4,
        refund_cycle_started_at = CASE
          WHEN $4 THEN NULL ELSE coalesce(refund_cycle_started_at, now()) END,
        refund_cycle_totals = CASE WHEN $4 THEN '{}'::jsonb ELSE $5::jsonb END,
        last_refund_scan_at = now(),
        next_refund_scan_at = CASE WHEN $4 THEN now() + ($6::bigint * interval '1 millisecond') ELSE now() END,
        updated_at = now(), version = version + 1
      WHERE shop_id = $1 AND assignment_token = $2
      RETURNING shop_id`, [
      shopId, leaseToken, json(normalized), Boolean(fullScanCompleted), json(totals), this.config.refundIntervalMs,
    ]);
    return Boolean(result.rowCount);
  }

  async complete({ assignment, exitCode = 0, signal = null, error = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`
        SELECT heat_state, hot_until, assignment_kind, assignment_started_at, failure_count
        FROM shop_schedule_state
        WHERE shop_id = $1 AND assignment_token = $2 FOR UPDATE`,
      [assignment.shopId, assignment.leaseToken]);
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      const state = current.rows[0];
      const activity = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM work_orders
          WHERE shop_id = $1 AND updated_at >= $2
            AND status NOT IN ('queued')
        ) AS active`, [assignment.shopId, state.assignment_started_at]);
      const businessActivity = Boolean(activity.rows[0]?.active);
      const failed = exitCode !== 0 || Boolean(error);
      const nextFailureCount = failed ? Number(state.failure_count || 0) + 1 : 0;
      const hotUntil = businessActivity
        ? new Date(Date.now() + this.config.hotWindowMs)
        : state.hot_until;
      const nextOrdinary = nextOrdinaryScanAt({ hotUntil, config: this.config });
      await client.query(`
        UPDATE browser_slots SET state = 'stopped', draining = false,
          metadata = metadata || $3::jsonb, updated_at = now()
        WHERE id = $1 AND lease_token = $2`, [
        assignment.slotId, assignment.leaseToken,
        json({ exitCode, signal, error: error?.message || null, stoppedAt: new Date().toISOString() }),
      ]);
      await client.query(`
        UPDATE shop_schedule_state SET heat_state = CASE WHEN $3 > now() THEN 'hot' ELSE 'cold' END,
          hot_until = $3, last_business_at = CASE WHEN $4 THEN now() ELSE last_business_at END,
          last_ordinary_scan_at = CASE WHEN assignment_kind IN ('ordinary','recovery') THEN now()
            ELSE last_ordinary_scan_at END,
          next_ordinary_scan_at = CASE WHEN assignment_kind IN ('ordinary','recovery') THEN $5
            ELSE next_ordinary_scan_at END,
          schedule_state = 'queued', queue_entered_at = now(), retry_at = NULL,
          failure_count = $7, last_failure = CASE WHEN $6 THEN $8 ELSE NULL END,
          assigned_slot_id = NULL, assignment_token = NULL, assignment_kind = NULL,
          assignment_started_at = NULL, assignment_expires_at = NULL,
          updated_at = now(), version = version + 1
        WHERE shop_id = $1 AND assignment_token = $2`, [
          assignment.shopId, assignment.leaseToken, hotUntil, businessActivity, nextOrdinary,
        failed, nextFailureCount, error?.message || `runner-exit:${exitCode ?? signal ?? 'unknown'}`,
      ]);
      await client.query('COMMIT');
      return true;
    } catch (completionError) {
      await client.query('ROLLBACK').catch(() => {});
      throw completionError;
    } finally {
      client.release();
    }
  }

  async markCapacityBlocked(reason = null) {
    await this.pool.query(`
      UPDATE shop_schedule_state schedule SET
        schedule_state = CASE WHEN $1::text IS NULL THEN 'queued' ELSE 'capacity-blocked' END,
        ordinary_overdue_reason = CASE
          WHEN schedule.next_ordinary_scan_at <= now() THEN $1 ELSE NULL END,
        refund_overdue_reason = CASE
          WHEN schedule.next_refund_scan_at <= now() THEN $1 ELSE NULL END,
        updated_at = now()
      FROM shops shop
      WHERE shop.id = schedule.shop_id AND shop.enabled = true
        AND schedule.assigned_slot_id IS NULL
        AND (schedule.next_ordinary_scan_at <= now() OR schedule.next_refund_scan_at <= now())`,
    [reason]);
  }

  async requestSession(shopId, kind = 'login') {
    if (!['login', 'business'].includes(kind)) throw new Error('scheduler-session-kind-invalid');
    const result = await this.pool.query(`
      UPDATE shop_schedule_state SET schedule_state = 'queued', queue_entered_at = now(),
        retry_at = NULL, metadata = metadata || jsonb_build_object(
          'manualSessionKind', $2::text,
          'manualSessionRequestedAt', now()
        ), updated_at = now(), version = version + 1
      WHERE shop_id = $1 RETURNING shop_id`, [shopId, kind === 'login' ? 'login' : 'business']);
    return Boolean(result.rowCount);
  }
}
