# PDD Windows server migration

This migration keeps the live application data but intentionally omits browser
login state. Each shop must be logged in once on the destination server.

The bundle contains:

- the application with `patches/162_new_ordinary_scenarios/overlay` applied;
- Node.js, PostgreSQL, MinIO, Chrome for Testing and extension `4.0.1.246`;
- `.env.native`, `secrets/staging`, MinIO objects, workflow state, evidence,
  diagnostics, logs and historical archives;
- a consistent custom-format PostgreSQL dump;
- the IIRPA native host, Chrome extension policy/environment installer and
  `PddCoreService` files;
- a SHA-256 manifest for critical files and a complete SQL migration catalog.

It excludes `browser-profile`, `auth`, `locks`, `tmp`, the console browser
profile and the live PostgreSQL physical cluster. PostgreSQL is transferred by
`pg_dump`, not by copying files while the database is running.

## Final export

Run from an elevated PowerShell window after stopping the worker, API, notifier,
sync and MinIO tasks. PostgreSQL may remain running for `pg_dump`.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\Export-PddServerMigration.ps1 `
  -DestinationRoot '\\SERVER\Transfer\pdd-migration-20260821' `
  -ConfirmSourceQuiesced
```

`-ConfirmSourceQuiesced` is mandatory for a final cutover package and may be
used only after the worker and supporting writers have been stopped and checked.
Without it the exporter writes `MIGRATION_PREVIEW.txt`; restore rejects that
bundle unless the explicit test-only `-AllowUnquiescedSnapshot` switch is used.

The destination must be empty. By default historical backups are included. The
bundle is an unencrypted, directly readable directory and is not wrapped in an
archive; only the PostgreSQL custom-format dump uses its normal internal
compression.

## Destination restore

Run as the Windows account that will operate the shop browsers, from an
elevated PowerShell window:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\Restore-PddServerMigration.ps1 `
  -BundleRoot 'D:\Transfer\pdd-migration-20260821' `
  -InstallRoot 'C:\pdd-native' `
  -Full
```

`-Full` restores PostgreSQL, applies every missing migration declared by the
bundle catalog, installs the native extension and scheduled tasks, and starts the
API/web supporting services. It does not start shop automation unless
`-StartWorker` is also supplied.

The exporter compares the source installation with the authoritative migration
directory, writes `payload/app/infra/db/migration-catalog.json`, and hashes every
SQL file. Bundle validation, restore and migration apply all reject missing,
extra or changed migrations. The apply step also verifies that every cataloged
SQL migration is recorded in `schema_migrations` after execution.

After every currently enabled shop has been logged in and its identity checked,
start the worker. The current installation has five shops, but the process is
dynamic and also covers shops added later from the frontend:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  C:\pdd-native\app\scripts\start-native-windows.ps1 -StartWorker -NoBrowser
```

Verify without sending DingTalk messages or submitting business actions:

```powershell
.\Test-PddServerMigration.ps1 -InstallRoot 'C:\pdd-native'
```

Static verification covers the two `4.0.1.246` extension copies, their hashes,
worker environment, Chrome force-install policy, IIRPA native-host registration
and the running/recovery state of `PddCoreService`. Each shop browser must still be checked after login to
prove that the extension is actually loaded in that browser process.

The restore script refuses to overwrite a non-empty installation directory.

To refresh tested application fixes in an existing release snapshot without
claiming that its database or object-storage snapshot is current, run:

```powershell
.\Refresh-ServerReleaseSnapshot.ps1 `
  -ReleaseRoot 'D:\Transfer\pdd-migration-20260821' `
  -SourceInstallRoot 'C:\pdd-native' `
  -ApplicationOverlayRoot '.\patches\162_new_ordinary_scenarios\overlay' `
  -RefreshApplicationOverlay
```

This mode synchronizes the complete SQL migration set from the source install,
applies the application overlay, writes a migration catalog, records the result
in snapshot metadata, and rebuilds and validates `SHA256SUMS.txt`. A final
stopped source refresh is still required for the latest PostgreSQL and MinIO data.

`Run-PddOverlayRegression.ps1` runs the complete offline overlay regression
suite in an isolated temporary copy without sending DingTalk messages or
submitting business actions.

The step-by-step Chinese cutover checklist is in `SERVER-MIGRATION-RUNBOOK-ZH.md`.
