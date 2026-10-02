# Node storage adapter

`createStandaloneBindings({ env?, dataDir?, migrationsDir? })` constructs an independent instance. `getStandaloneBindings()` caches one instance for the process. Both return `PortalBindings` plus `close()`. Runtime imports remain type-only.

Run on Node 24. `node:sqlite` is built in and needs no native addon or experimental startup flag; this Node release can still emit its SQLite experimental warning. `DatabaseSync` operations are synchronous. A batch holds `BEGIN IMMEDIATE` through every statement and `COMMIT` without awaiting promises. SQLite WAL and a 5-second busy timeout coordinate other processes. Query values use native parameter binding. Statements from another connection, multiple statements passed to `prepare`, and caller-managed transaction control are rejected.

The D1-compatible surface is `prepare/bind/first/all/run/raw/batch/exec`. `run` and `batch` also collect `RETURNING` rows, with the affected-row count in `meta.changes`. Metadata row counts are local estimates; this is not a replica of D1's analytics, sessions, bookmarks or administrative APIs. The R2-compatible surface is whole-object `put/get/delete` and returned object `body/arrayBuffer/text/json/blob/size`. Conditional, multipart and range operations are rejected. Objects are limited to 16 MiB (portal validation further limits uploaded files to 5 MiB).

`DATA_DIR` defaults to `~/.local/share/mentor-portal`. It contains `portal.sqlite` and `objects/`, with directories mode 0700 and files mode 0600. Keep this directory outside public/static content and mount persistent storage here in a container. Object keys are validated, then mapped to SHA-256 filenames. Bytes and metadata are written together to a new temporary file, fsynced, and atomically renamed; readers check the key, length and digest. Symbolic-link reads are rejected.

`MIGRATIONS_DIR` defaults to `<cwd>/drizzle`. Ship that directory with the standalone bundle. Migration files run in order under one transaction and are recorded in `_portal_migrations` with a SHA-256 checksum. Repeated startup does not rerun them; modified/missing applied migrations fail startup. Back up the SQLite database using SQLite's backup facilities or after clean shutdown; copying only the live main file can omit WAL data.

Settings pass through `APP_ORIGIN`, `SETUP_TOKEN`, `TRUST_PROXY` and `MENTOR_*`. Defaults are live mode, cache enabled, and live writes disabled. No database contents, account secrets or remote data are imported by this adapter.
