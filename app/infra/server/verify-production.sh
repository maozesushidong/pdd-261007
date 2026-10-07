#!/bin/sh
set -eu

INSTALL_ROOT="${INSTALL_ROOT:-/opt/pdd-workflow/current}"
SECRET_ROOT="${SECRET_ROOT:-/etc/pdd-workflow/secrets}"
PUBLIC_IP="${PUBLIC_IP:?set PUBLIC_IP}"
COMPOSE_FILE="$INSTALL_ROOT/infra/docker/docker-compose.production.yml"
ENV_FILE="$INSTALL_ROOT/.env.production"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
    --project-name pdd-workflow-production --profile visual --profile worker "$@"
}

compose ps
password="$(cat "$SECRET_ROOT/GATEWAY_INITIAL_PASSWORD")"
base="https://$PUBLIC_IP:10443"
curl --fail --silent --show-error --cacert "$SECRET_ROOT/GATEWAY_CA_CERT" -u "pddadmin:$password" "$base/" >/dev/null
curl --fail --silent --show-error --cacert "$SECRET_ROOT/GATEWAY_CA_CERT" -u "pddadmin:$password" "$base/api/v1/runtime" >/dev/null
curl --fail --silent --show-error --cacert "$SECRET_ROOT/GATEWAY_CA_CERT" -u "pddadmin:$password" \
  "$base/remote-desktop/vnc.html?autoconnect=false&resize=scale&path=remote-desktop%2Fwebsockify%3Ftoken%3Dshop-0" >/dev/null
echo "production gateway, API, web, and remote desktop entry point passed"
