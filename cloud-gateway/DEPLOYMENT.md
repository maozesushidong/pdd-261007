# PDD ordinary viewer cloud entry

Preferred public URL: https://xmrcpd.xianmaec.com/pdd/ (selected by the user on 2026-09-23). The IP entry https://47.96.184.148/pdd/ remains available. Both URLs without a trailing slash redirect to the corresponding /pdd/ path.
Deployed 2026-09-23. This is the ordinary viewer only. The owner frontend remains on the existing local/public 5148 entry with its concealed login behavior.

The cloud hosts the ordinary frontend's static build. Its read-only API travels through an SSH reverse tunnel to the existing Windows public listener at 127.0.0.1:5145. The Windows computer must remain running and connected. No shop browser sessions, business workers, database, or DingTalk sender were migrated or restarted for this change.

## Runtime

- Windows task: `PDD Local Public Gateway Tunnel`, SYSTEM, at startup, hidden, auto reconnect every 10 seconds after failure. Files are in this directory; the SSH private key is restricted to SYSTEM and Administrators. Do not publish or copy the private key.
- Cloud SSH account: `pdd-public-tunnel`, public-key-only, no shell/session, reverse forwarding only, loopback binds only.
- Cloud tunnel: `127.0.0.1:15145` to Windows `127.0.0.1:5145`.
- Cloud private bridge: `172.23.0.1:15146`, accessible only from the existing Docker subnet, using isolated `pdd-public-tunnel-bridge.service`. It has a separate Nginx process and config under `/opt/pdd-public-gateway/bridge`.
- Existing HTTPS container `docker-nginx-1`: `pdd-public-ip-https.conf` serves the IP entry. `xmrcpd-https.conf` also has the same isolated `/pdd` locations added for the selected domain. Existing root and Douyin routing is retained; the other domain configs and all existing domain certificates were left unchanged. No new public listener on 5145 was opened.
- Cloud static files: `/opt/dify/dify-main/docker/nginx/ssl/pdd-public-gateway/site/pdd/`, visible inside the HTTPS container under `/etc/ssl/pdd-public-gateway/site/pdd/`.

## Certificate

The preferred domain uses the existing `xmrcpd.xianmaec.com` HTTPS certificate and its existing certificate-management setup. No extra certificate or public port was required for the added path. Its original homepage bytes and Douyin route were checked after the update. Domain route backup: `/opt/pdd-public-gateway/backups/domain-xmrcpd.xianmaec.com-20260923-174036`.

Production Let's Encrypt certificate, IP SAN `47.96.184.148`, initially expires 2026-09-30 00:11:51 UTC. The private LAN IP is not included. Existing local temporary certificates remain unchanged.

Certbot state: `/opt/pdd-public-gateway/certbot`. The existing HTTP validation webroot is reused without changing the port 80 site's configuration. `pdd-public-certificate-renew.timer` checks every six hours. The renewal script verifies the certificate, key match, IP identity and remaining lifetime, switches a versioned certificate directory atomically and gracefully reloads only the existing HTTPS container when the certificate changes. It retains the previous certificate path on installation failure. No CA private key is stored in this document or the application source.

## Frontend builds

The existing local `dist-public` build was left unchanged. The source now supports optional `PUBLIC_WEB_BASE`, `PUBLIC_WEB_OUT_DIR`, and `VITE_PUBLIC_API_PREFIX` build values. Cloud values are `/pdd/`, `dist-public-cloud`, and `/pdd/public-api`. Build with the existing `vite.public.config.js`; future UI changes need the resulting cloud build copied to the cloud static directory as well. Do not expose the owner build or replace any existing site's root.

The missing trend styles were restored from the working local build into `apps/web/src/public-trend.css`, imported by `public-main.jsx`, on 2026-09-23. New builds now preserve the metric grid, SVG line colors, transparent tooltip targets and responsive layout. Cloud assets are uploaded before an atomic switch of `public.html`; old hashed assets are retained for already-open pages. The trend regression check waits for actual chart data and checks day/week/month views, multiple dates, tooltips and mobile layout rather than accepting the initial loading state. Cloud rollback assets are under `/opt/pdd-public-gateway/backups/trend-styles-20260923`.

## Verification and recovery

Verified with normal Node, Chromium and independent Windows-server certificate validation (no certificate bypass): /pdd redirect, frontend navigation, live summary data, all frontend requests scoped below /pdd, private API and write API rejection. Forced one dedicated SSH disconnect and confirmed automatic reconnection and data recovery. Certbot renewal dry run passed. Existing IP-root and Douyin HTML responses matched their previous bytes; both existing domain HTTPS sites still returned 200 with their original certificates. Original Nginx configuration checksums were unchanged.

Cloud backups and helpers: `/opt/pdd-public-gateway/backups` and `/opt/pdd-public-gateway`. Local source backups: `D:\pdd-native\backups\cloud-public-gateway-20260923`. Detailed verification results are in this task workspace's `work/cloud-*` files.

To withdraw this entry, disable the dedicated Windows tunnel task and the two new cloud units, disable only `pdd-public-ip-https.conf`, validate and gracefully reload `docker-nginx-1`. Preserve all original web server configs and services. SSH policy changes are a clearly marked final `Match User pdd-public-tunnel` block; remove only that block when decommissioning. Do not restore full shared configs over unrelated future changes.

To withdraw the domain alias as well, remove only the added `/pdd` locations from `xmrcpd-https.conf` (marked `PDD ordinary viewer, sharing the existing HTTPS certificate`), then validate and gracefully reload the existing HTTPS container. Keep the domain's original routes and certificate directives.
