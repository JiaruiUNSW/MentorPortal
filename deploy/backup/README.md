# Online pre-feature backup

`run-backup.py` targets only the reviewed `service-manager` Portal deployment. It refuses an enabled live-write switch or an unexpected release/container/data-volume layout. It reads only the selected non-secret environment fields; it does not copy the private environment file.

The current deployed image runs a one-shot process with networking disabled and the source data volume mounted read-only. A synthetic WAL test first verifies that image's `node:sqlite.backup` API. The real backup pins a read-only database snapshot and uses SQLite's backup API, including committed WAL pages. Login and background cache synchronization may continue.

With business writes disabled, bucket content is archived and its complete inventory is checked before/after capture. The saved database and object archive are restored to a separate private temporary directory, validated with `integrity_check`, foreign-key checks, table counts, account/pilot-cache presence and exact object hashes, then the temporary restore is removed. No source database, production restore or application setting is changed.

Backups are written under `/opt/mentor-portal/backups/<UTC timestamp>` with a `0700` directory and `0600` database, archive and manifest. The manifest records image/release identifiers, migration checksums and artifact hashes privately. Output contains only counts, public versions, booleans and the private backup path. Keep the previous release/image until the upgrade is verified. This backup intentionally excludes environment secrets; their existing private storage remains required for disaster recovery.

On SELinux hosts, the one-shot container applies a private `:Z` label only to its newly created backup directory. The production named volume is never relabeled and stays mounted read-only in the backup process.

Run from the local checkout, with authorized SSH access:

```sh
python3 deploy/backup/run-backup.py
```

The local non-secret status record is written outside the public checkout to `outputs/mentor-editing-usso-20261003/backup-status.json`. A changed deployment/write guard, object inventory mismatch or failed integrity check returns failure. SQLite API reference: <https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options>.

## Migration-aware rollback verification

The storage adapter refuses an applied migration that is missing from an image. The original `6ab87d3` image therefore cannot open a database after migrations `0003`/`0004`. A rollback image must retain the old application code **and the exact applied migration files**. Do not restore the pre-upgrade database over production merely to bypass this check; that would discard subsequent data.

`run-upgrade-check.py` accepts reviewed candidate/rollback tags and exact image digests. It copies the verified backup into a new private directory, starts the candidate with that copy to apply migrations, then starts the rollback image on the same migrated copy. Only readiness, integrity, migration names and aggregate account/cache/table counts are checked. Both containers have no external network, no published ports and dummy non-secret settings; the production volume and private environment file are never mounted/read. No user login is attempted. The copy is removed after verification and a private result is retained beside the backup.

The check uses the reviewed checkout's exact migration inventory, including the
durable write-queue migration. A rollback image must carry that same inventory.
Before rolling back to application code without queue support, disable live
writes and asynchronous acceptance, let the current writer finish, and verify
that no queued, running or unresolved write jobs remain. Keep the database and
queue records intact. An older application cannot enforce a pending queue's
group reservations, so do not re-enable its writes while jobs need resolution.

Backups also inspect `mentor-portal-writer-1` when installed. Recreate all Portal
services with live writes disabled before running the backup; allow their
configured shutdown grace period so an in-flight HTTPS request can finish.
