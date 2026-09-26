# ExternalMemory canonical writer: read-only preflight

Memhub must not launch a second ExternalMemory Continuity/Advance writer because
an automation says it is time to run. The canonical project is an independent
working tree. Its two supported runners use the same POSIX `flock` on
`.continuity_advance.lock`; the on-disk JSON owner is **not** proof that the
kernel lock is held or released.

On the Linux host, use:

```sh
node scripts/externalmemory-writer-preflight.mjs /srv/externalmemory_history/working/chronological/dsh-fast-chrono-00301-03470
```

The command reads only the lock metadata, `/proc/locks`, and matching
process command lines/cwds. It does not acquire `flock`, clear a stale
marker, modify checkpoint/manifest, open the production DB, or start a runner.
Its output is a snapshot with one of: `active`, `overlap`, `idle`,
`stale_or_unknown`, or `unknown`. Exit 3 and `block_new_writer=true`
mean do not launch. Exit 0 is only the observed `idle` case, **not a
reservation**: the actual canonical runner still must take its own atomic
exclusive `flock` before reading or changing a checkpoint. Recheck a
scheduler trigger immediately before launch, and never treat the absence
of a readable process as permission to remove an unknown lock.

The current ChatGPT hourly ExternalMemory automation is a separate scheduling
host from Linux systemd. A disabled task, a queued DevSpace job, and an
active OS writer are distinct facts; the absence of a local systemd timer
does not prove that no runner exists. A periodic task needs both this
fail-closed diagnostic and the canonical writer's own lock, and must not
start another runner when it finds `active` or `overlap`.

This implementation is Linux-only. Do not infer an equivalent Windows
kernel-lock guarantee from a PID file or from a PowerShell port check.

## Production snapshot, 2026-09-26 22:44 +08

The read-only preflight was run against the canonical ExternalMemory directory
while a manual chronological batch was active. It returned
`status=unknown`, `block_new_writer=true`: the JSON owner PID in the lock
was no longer alive, while the kernel flock holder was a live
`manual_batch_3031_3040.py` process with cwd in the canonical
`externalmemory_history` tree. No lock was acquired, cleared or rewritten.
This is intentionally fail-closed: stale owner metadata must not turn an
observed kernel lock into permission to launch a second writer.

The ChatGPT task `ExternalMemory 每小时蒸馏` was independently observed disabled
at the same time. That scheduler state is not used as writer ownership proof;
the kernel-lock/process preflight remains the launch-time safety gate.
