# Memhub Core migration

This document describes the production-safe migration from the deployed schema-v7 Memory Core to the schema-v8 L1/L2/L3/L4/Skill model.

## Current production boundary

- `memhub-core.service` runs the vendored Memory Core.
- `memhub.service` runs the Memhub gateway/control plane.
- The active SQLite path remains `~/.memmy/memory-service/memory.sqlite` for continuity.
- The old Normify engine is not a runtime dependency. Existing project architecture Markdown is read through the lightweight compatibility reader.

## Invariants

1. The existing SQLite database is adopted in place; memory IDs are not regenerated.
2. Historical durable rows are preserved. Schema-v8 semantic retirement archives old L2/L3 and `user_memories`; it does not silently delete them.
3. SQLite integrity must remain `ok`.
4. Every durable table present in the baseline must still exist after cutover.
5. Every durable baseline row identity must still exist after migration.
6. A consistent online backup is created before production ownership/state changes.
7. Production service restart/migration is a separate authorized operation; passing tests alone does not perform cutover.

## What v8 changes

Schema v8 changes the allowed durable memory layers to:

```text
L1 / L2 / L3 / L4 / Skill
```

During v7 -> v8 migration:

- legacy active L2/L3 rows are archived and marked as the previous memory model;
- active legacy `user_memories` are archived;
- retired evolution jobs are moved to dead-letter state;
- embedding retry targets are remapped from old Policy/World Model names to timeline/project-profile names;
- historical rows remain present for audit and evidence lineage.

## Phase 1 — preflight

For routine health checks that must not create another rollback snapshot, use:

```bash
npm run core:check
```

`core:check` verifies vendored runtime parity plus the live SQLite integrity/fingerprint and does not write under `core-migrations/`.

Only run the snapshot-producing preflight when a real migration/cutover rollback boundary is needed:

Run from the repository:

```bash
npm run core:preflight
```

The command:

- verifies the current vendored Memory Core tree against `vendor/manifest.json`;
- verifies the vendored AgentSource helper;
- runs SQLite `quick_check`;
- creates an online backup under the configured migration state root;
- fingerprints schema and durable tables;
- writes a migration manifest without exposing storage credentials.

The backup is the rollback boundary.

## Phase 2 — shadow migration

Never test schema v8 by pointing experimental code at the live database.

1. Create an online backup of the live v7 database.
2. Copy that backup to a disposable shadow path.
3. Open the copy through the new `MemoryDb` initialization path so the real migration code runs.
4. Confirm migration version 7 -> 8 and SQLite integrity.
5. Run `core:preserved` against the v7 baseline and migrated copy.

This validates the actual migration function without touching production.

## Phase 3 — quiesced production cutover

The production cutover must establish one frozen baseline and prevent concurrent writes while exact migration ownership changes occur:

1. stop gateway/capture writers;
2. stop `memhub-core.service`;
3. create the final preflight baseline;
4. start the v8 Memory Core against the existing database path;
5. verify migration/integrity;
6. start the Memhub gateway;
7. run MCP, Control Plane and representative recall/capture smoke tests;
8. run preservation verification before declaring the cutover complete.

## Exact verification versus preservation verification

`core:verify` is for a frozen copy where schema/content should match the recorded baseline exactly:

```bash
npm run core:verify -- --manifest <manifest>
```

After a deliberate schema migration or once normal writes resume, exact schema/content hashes may legitimately differ. Use:

```bash
npm run core:preserved -- --manifest <manifest>
```

`core:preserved` reports schema hash/version changes as audit information and enforces:

- current SQLite integrity is `ok`;
- no baseline durable table disappeared;
- no baseline durable primary-key identity disappeared;
- tables without primary keys did not shrink.

New rows and legitimate state updates do not create false failures.

## Rollback

Do not delete the pre-cutover online backup during the migration window. If the new service fails before acceptance, restore service ownership using the frozen backup and the previously deployed code/configuration.

Do not treat an old running process as a rollback copy after writes have diverged; the immutable snapshot is the rollback source of truth.

## Architecture compatibility

Project architecture is not flattened into ordinary memory. The current runtime reads existing authoritative Markdown using `FileProjectArchitectureSource`. New configuration uses `--architecture-root`; the legacy `--normify-root` CLI option remains a deprecated alias so existing service units can restart during migration.
