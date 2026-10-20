#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { verifyNdjsonBundle } from "../vendor/memory-core/src/service/bundle-ndjson.js";
const file = process.argv[2];
if (!file) {
    console.error(JSON.stringify({ ok: false, error: "usage: node scripts/verify-bundle.mjs <bundle.ndjson>" }));
    process.exit(2);
}
try {
    const summary = await verifyNdjsonBundle(createReadStream(file));
    console.log(JSON.stringify({
        ok: true,
        format: summary.format,
        exportId: summary.exportId,
        schemaVersion: summary.schemaVersion,
        snapshotAt: summary.snapshotAt,
        tables: summary.tables.length,
        rows: summary.rows,
        bytes: summary.bytes,
        headerSha256: summary.headerSha256,
        manifestSha256: summary.manifestSha256
    }));
}
catch (error) {
    // Never print row data or raw SQL; the verifier's own messages are sanitized.
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
}
