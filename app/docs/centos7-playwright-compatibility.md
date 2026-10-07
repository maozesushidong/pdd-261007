# CentOS 7 Playwright compatibility report

Test date: 2026-07-30 (Asia/Shanghai)

Target host: `47.96.184.148`

## Result

The short compatibility test passed. The CentOS 7 host can start the current
Linux Playwright worker image with three independent headed Chromium sessions,
three Xvfb displays, VNC, and noVNC.

The originally planned 30-minute soak test was stopped at the user's request.
This report therefore proves basic and short-duration compatibility, not a
30-minute stability acceptance test.

No PDD, OMS, or TMS URL was opened. No platform credential, production Browser
Profile, PostgreSQL data, MinIO data, or business state was mounted or migrated.
The Windows business Workers were not stopped.

## Environment

- Operating system: CentOS Linux 7
- Kernel: `3.10.0-1160.119.1.el7.x86_64`
- CPU: 8 cores
- Memory: approximately 30 GB
- Docker test project: `pdd-workflow-compatibility`
- Server test directory: `/opt/pdd-workflow-compatibility`
- Displays: `:99`, `:100`, and `:101`
- noVNC bindings: server loopback `127.0.0.1:6080-6082`

The uploaded image archive is retained for traceability:

```text
/opt/pdd-workflow-compatibility/pdd-compat-images.tar
size: 1,020,622,336 bytes
sha256: c3ab02322f866d3c8dfbf53c70be3041b082278c7b5f15ff71dd77c2d068c319
```

Server image IDs used by the test:

```text
pdd-workflow-worker:staging
sha256:defe11f3874c3a51cd52da08c1a013b63a35b800d5fe543a0606cf3131adf1f3

pdd-workflow-desktop:playwright-1.61.1
sha256:4e34ef3bdd7ff63465fc92fff5abe9a292c479f9624b50958a34ad265533985e
```

The mutable Windows `staging` tags were rebuilt after the archive was created,
so their current image IDs differ. Production releases must use versioned tags
and immutable image digests rather than `staging` or `latest`.

## Checks completed

Each runner completed the following checks and wrote `status: passed`:

- Created a headed Chromium Persistent Context.
- Opened a local test page without any external platform access.
- Filled an input and clicked a button.
- Opened and closed a new tab.
- Opened and accepted a JavaScript dialog.
- Captured a `1920x1080` screenshot.
- Closed Chromium and restarted it with the same temporary Profile.
- Verified that LocalStorage persisted after restart.
- Captured a final nonblank screenshot.

All three final results included:

```text
persistentProfileRestored: true
popupPassed: true
dialogPassed: true
screenshotPassed: true
```

Additional checks:

- All compatibility containers had `RestartCount=0`.
- The display container was healthy.
- All three noVNC HTTP endpoints returned `200` on server loopback.
- `xdpyinfo` succeeded for `:99`, `:100`, and `:101`.
- No `kernel too old`, missing symbol, sandbox, namespace, Chromium crash,
  segmentation fault, OOM, or display-open error was found.
- Available memory during the final run was approximately 23.4 GB.
- Disk available during and after the test was 32 GB.

One simultaneous screenshot attempt initially returned `Unable to capture
screenshot` for the medical-device runner. The same display had already
captured screenshots successfully during the earlier run. The test harness now
retries a screenshot up to three times with a one-second delay. A clean-profile
medical-device rerun then completed with `status: passed` and exit code `0`.

## Existing-container comparison

The host had 34 pre-existing containers. None was restarted or modified by the
compatibility project. Healthy containers remained healthy and all normally
running containers retained their prior restart counts.

Three old Dify containers were already in continuous restart loops before the
test and continued that pre-existing behavior:

```text
dify-worker_beat-1
dify-sandbox-1
dify-ssrf_proxy-1
```

Their state is unrelated to this test, but it should be handled separately
before using this host as a production server.

## Cleanup

After evidence collection, only the isolated compatibility resources were
removed:

- Compatibility containers: none left
- Compatibility network: none left
- Temporary X11/Profile volumes: none left

The baseline, JSON results, logs, and screenshots remain under
`/opt/pdd-workflow-compatibility`. A local evidence copy is also stored in the
Windows temporary directory `pdd-playwright-compatibility-20260730`.

## Safe rerun

Run from `/opt/pdd-workflow-compatibility/infra/docker`:

```bash
COMPAT_DURATION_MS=1800000 COMPAT_HEARTBEAT_MS=30000 \
  docker compose \
  -p pdd-workflow-compatibility \
  -f docker-compose.compatibility.yml up -d
```

To perform only a quick one-minute check, set `COMPAT_DURATION_MS=60000` and
`COMPAT_HEARTBEAT_MS=10000`.

After collecting evidence, remove only this explicitly scoped test project:

```bash
docker compose \
  -p pdd-workflow-compatibility \
  -f docker-compose.compatibility.yml down --volumes --remove-orphans
```

Do not run an unscoped cleanup command and do not remove existing Docker images,
volumes, networks, or containers.

## Deployment decision

The host is compatible enough to proceed to the next non-business deployment
stage: version-pinned API, Web, PostgreSQL, Redis, MinIO, and browser services
with Workers disabled. Production data migration and real Worker activation
remain separate gated steps.

