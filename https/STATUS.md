# Temporary HTTPS enabled — 2026-09-23

Both frontend ports accept HTTP and HTTPS in the existing Node web process:
- Public: http://183.214.198.74:5145/ and https://183.214.198.74:5145/
- Owner: http://183.214.198.74:5148/ and https://183.214.198.74:5148/

The user requested a temporary self-signed certificate after public port 80 verification failed. Browsers will display a certificate trust warning unless the user accepts the certificate for this site. No system or browser root trust store was modified.

Certificate and private key: D:\pdd-native\https\self-signed\server.pem. Directory access is restricted to Administrators, SYSTEM and the creating account. SANs cover 183.214.198.74, 10.10.12.188, 127.0.0.1, ::1 and localhost.

The certificate lasts 90 days. ensure-local-https-certificate.ps1 renews it when fewer than 30 days remain. The PDD Local HTTPS Certificate Windows task runs at startup and daily at 07:00. start-local.ps1 also checks the certificate. The frontend checks for atomic certificate replacement every 30 seconds and loads it without restarting or losing owner entries.

New owner visits, reloads and copied consumed entry links still start at 404; Ctrl+Shift+H reveals a fresh login. Both protocols preserve the public API allowlist and owner authentication/CSRF behavior. Authentication proxy headers derive their scheme from the actual socket.

Verification covered both protocols on one port, concurrent keep-alive requests, POST bodies, HTTP/TLS upgrades, certificate reload, isolated owner login/session behavior, and live UI/read-only API smoke checks. External probes pin the exact issued certificate and return public HTTP/HTTPS 200 and owner HTTP/HTTPS 404. The certificate task completed with result 0. No DingTalk messages were sent.

The unused local Caddy validation process was stopped and its temporary port 80/443 firewall rules removed. Public CA requests are no longer retrying. The old server's PDD frontends remain stopped.

Backup and verification: D:\pdd-native\backups\temporary-https-20260923

## Public certificate request recheck — 2026-09-23

The user now requests trusted HTTPS for 183.214.198.74:5145 and 10.10.12.188:5145. Publicly trusted issuance can cover the public IP; the private LAN IP is not eligible. Existing self-signed HTTPS remains unchanged and was reverified successfully (public 5145: 200, concealed owner 5148: 404).

The local HTTP-only Caddy validation listener was started again (PID 111776 at the time of this check), with the PDD-Local-ACME-80 firewall rule scoped to the Caddy executable. Localhost and LAN validation marker requests return 200. An independent probe from the old server still times out on public port 80 while public 5145 returns 200 and 5148 returns 404. No new production certificate has been requested or issued. Caddy currently serves only the validation marker and otherwise 404; it is not an automatic public-certificate renewal service.

Starting an additional temporary TLS 443 probe was rejected by automatic approval with only "blocked by policy". The command did not run, no 443 listener or firewall rule was added, and 443 was not revalidated. The user was asked for router/ONT models to locate the failed public forwarding path. Verification details: workspace work/certificate-public-validation-recheck.json. Never install a staging certificate into the live frontend, and do not overwrite the self-signed bundle with a public-only certificate without accounting for LAN access and its renewal task.

## Trusted cloud entry deployed — 2026-09-23

The user supplied a different cloud server and requested a shared `/pdd` path. The ordinary viewer is now available at https://47.96.184.148/pdd/ using a production, publicly trusted Let's Encrypt IP certificate with automatic renewal. This cloud entry uses an encrypted reverse SSH tunnel to the existing local ordinary API. Both local frontends and their temporary TLS certificates remain unchanged. See `D:\pdd-native\cloud-gateway\DEPLOYMENT.md` for the runtime and recovery details.

The temporary local Caddy validation process (111776) was stopped after identity verification, and its exact port 80 firewall rule was removed. No public certificate retries remain on this Windows computer. The old 121.196.220.219 PDD frontends remain stopped.
