#!/bin/sh
set -eu

INSTALL_ROOT="${INSTALL_ROOT:-/opt/pdd-workflow/current}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/pdd-workflow}"
COMPOSE_FILE="$INSTALL_ROOT/infra/docker/docker-compose.production.yml"
ENV_FILE="$INSTALL_ROOT/.env.production"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_ROOT/$stamp"

test -f "$COMPOSE_FILE"
test -f "$ENV_FILE"
mkdir -p "$target/minio"
chmod 700 "$target"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --project-name pdd-workflow-production "$@"
}

compose exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$target/postgres.dump"
compose run --rm --no-deps -v "$target/minio:/backup" --entrypoint /bin/sh minio-init -c '
  mc alias set source http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&
  mc mirror --overwrite "source/$S3_BUCKET" /backup
'

docker run --rm \
  -v "pdd-workflow-production_workflow-production-data:/source:ro" \
  -v "$target:/backup" \
  alpine:3.21 tar -C /source -czf /backup/workflow-production-data.tar.gz .

compose ps --format json > "$target/compose-services.json"
compose images --format json > "$target/compose-images.json"
(cd "$target" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
chmod -R go-rwx "$target"
echo "$target"
