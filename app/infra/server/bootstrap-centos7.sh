#!/bin/sh
set -eu

PUBLIC_IP="${PUBLIC_IP:?set PUBLIC_IP}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/pdd-workflow}"
SECRET_ROOT="${SECRET_ROOT:-/etc/pdd-workflow/secrets}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/pdd-workflow}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT/releases" "$INSTALL_ROOT/debug" "$SECRET_ROOT" "$BACKUP_ROOT"
chmod 700 "$SECRET_ROOT" "$BACKUP_ROOT"

if ! id pdddeploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash pdddeploy
fi
chown -R pdddeploy:pdddeploy "$INSTALL_ROOT"

if [ ! -f "$SECRET_ROOT/GATEWAY_CA_CERT" ]; then
  umask 077
  openssl genrsa -out "$SECRET_ROOT/GATEWAY_CA_KEY" 4096
  openssl req -x509 -new -sha256 -days 3650 \
    -key "$SECRET_ROOT/GATEWAY_CA_KEY" -out "$SECRET_ROOT/GATEWAY_CA_CERT" \
    -subj "/CN=PDD Workflow Private CA"
  openssl genrsa -out "$SECRET_ROOT/GATEWAY_TLS_KEY" 3072
  openssl req -new -key "$SECRET_ROOT/GATEWAY_TLS_KEY" \
    -out "$SECRET_ROOT/GATEWAY_TLS_CSR" -subj "/CN=$PUBLIC_IP"
  printf 'subjectAltName=IP:%s\nextendedKeyUsage=serverAuth\n' "$PUBLIC_IP" > "$SECRET_ROOT/GATEWAY_TLS_EXT"
  openssl x509 -req -sha256 -days 825 -in "$SECRET_ROOT/GATEWAY_TLS_CSR" \
    -CA "$SECRET_ROOT/GATEWAY_CA_CERT" -CAkey "$SECRET_ROOT/GATEWAY_CA_KEY" -CAcreateserial \
    -extfile "$SECRET_ROOT/GATEWAY_TLS_EXT" -out "$SECRET_ROOT/GATEWAY_TLS_CERT"
fi

if [ ! -f "$SECRET_ROOT/GATEWAY_HTPASSWD" ]; then
  gateway_password="$(openssl rand -base64 24 | tr -d '\n=/+' | cut -c1-24)"
  printf '%s\n' "$gateway_password" > "$SECRET_ROOT/GATEWAY_INITIAL_PASSWORD"
  printf 'pddadmin:%s\n' "$(openssl passwd -apr1 "$gateway_password")" > "$SECRET_ROOT/GATEWAY_HTPASSWD"
fi

chmod 600 "$SECRET_ROOT"/*
chmod 644 "$SECRET_ROOT/GATEWAY_CA_CERT" "$SECRET_ROOT/GATEWAY_TLS_CERT"

echo "server bootstrap complete"
echo "CA certificate: $SECRET_ROOT/GATEWAY_CA_CERT"
echo "gateway user: pddadmin"
echo "initial gateway password: $SECRET_ROOT/GATEWAY_INITIAL_PASSWORD"
