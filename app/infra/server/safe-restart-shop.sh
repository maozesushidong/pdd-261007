#!/bin/sh
set -eu

shop="${1:-}"
case "$shop" in
  healthcare) shop_id=panapopo-healthcare ;;
  medical-device) shop_id=panapopo-medical-device ;;
  songteng) shop_id=songteng-yazc-overseas ;;
  *) shop_id="$shop" ;;
esac

case "$shop_id" in
  ''|*[!a-z0-9-]*) echo "usage: $0 healthcare|medical-device|songteng|shop-id" >&2; exit 2 ;;
esac

INSTALL_ROOT="${INSTALL_ROOT:-/opt/pdd-workflow/current}"
compose() {
  docker compose --env-file "$INSTALL_ROOT/.env.production" \
    -f "$INSTALL_ROOT/infra/docker/docker-compose.production.yml" \
    --project-name pdd-workflow-production --profile visual --profile worker "$@"
}

db_user="$(sed -n 's/^POSTGRES_USER=//p' "$INSTALL_ROOT/.env.production" | tail -1)"
db_name="$(sed -n 's/^POSTGRES_DB=//p' "$INSTALL_ROOT/.env.production" | tail -1)"
db_user="${db_user:-workorders}"
db_name="${db_name:-workorders}"

runtime="$(compose exec -T postgres psql -U "$db_user" -d "$db_name" -Atc \
  "SELECT coalesce(status, 'missing') || '|' || coalesce(current_work_order_id::text, '') FROM shop_runtime_state WHERE shop_id = '$shop_id'")"
case "$runtime" in
  *'|'?*) echo "shop $shop_id still owns a work order ($runtime); pause it and wait until idle" >&2; exit 1 ;;
esac

updated="$(compose exec -T postgres psql -U "$db_user" -d "$db_name" -Atc \
  "UPDATE shops SET config_version = config_version + 1, updated_at = now() WHERE id = '$shop_id' RETURNING id")"
test "$updated" = "$shop_id" || { echo "shop not found: $shop_id" >&2; exit 1; }

sleep 8
compose ps worker
compose logs --tail 120 worker
