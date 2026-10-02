// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createHash } from 'node:crypto';
import { open, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createDatabase } from '../src/db/client.js';
import { readConfig } from '../src/config.js';
import { readDemoConfig, readPrivateDemoEnvironment } from './demo-config.js';
import { convertLegacyContent } from './content-upgrade/convert.js';

type LegacyRevision = { id: string; contentFormat: string; contentSchemaVersion: number; body: unknown };

/** Requires a private original-data archive before the first write. No reset path. */
export async function upgradeContent(pool: Pool, options: { backup?: string; apply: boolean }) {
  if (options.apply && !options.backup) throw new Error('Applying conversion requires an original-data archive path');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Application must be stopped. Locks also prevent an overlapping write from
    // changing the snapshots between preservation and conversion.
    await client.query('LOCK TABLE "Document", "DocumentRevision" IN ACCESS EXCLUSIVE MODE');
    const documents = await client.query('SELECT * FROM "Document" ORDER BY "id"');
    const revisions = await client.query<LegacyRevision>('SELECT * FROM "DocumentRevision" ORDER BY "documentId", "revisionNumber"');
    const conversions = revisions.rows.filter(row => row.contentFormat === 'prosemirror-json').map(row => ({
      id: row.id, ...convertLegacyContent({ format: row.contentFormat, schemaVersion: row.contentSchemaVersion, document: row.body }, row.id),
    }));
    if (revisions.rows.some(row => !['prosemirror-json', 'blocknote-json'].includes(row.contentFormat))) {
      throw new Error('Unknown stored content format');
    }
    if (options.apply && conversions.length) {
      const archive = JSON.stringify({ format: 'scrawl-content-upgrade-originals', version: 1,
        documents: documents.rows, revisions: revisions.rows }, null, 2) + '\n';
      const path = resolve(options.backup!);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(archive); await file.sync(); } finally { await file.close(); }
      // The archive is durable before changing historical encodings. It contains
      // document provenance/content only, never auth records or session data.
      for (const converted of conversions) {
        await client.query(`UPDATE "DocumentRevision" SET "contentFormat" = $2, "contentSchemaVersion" = $3,
          "contentEditorVersion" = $4, "body" = $5::jsonb, "plainText" = $6 WHERE "id" = $1::uuid`,
        [converted.id, converted.content.format, converted.content.schemaVersion, converted.content.editorVersion,
          JSON.stringify(converted.content.document), converted.plainText]);
      }
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('COMMIT');
      return { converted: conversions.length, documents: documents.rowCount ?? 0, revisions: revisions.rowCount ?? 0,
        archiveSha256: createHash('sha256').update(archive).digest('hex') };
    }
    await client.query('ROLLBACK');
    return { converted: options.apply ? 0 : conversions.length, documents: documents.rowCount ?? 0, revisions: revisions.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function main() {
  const args = process.argv.slice(2);
  const demo = args[0] === '--demo'; if (demo) args.shift();
  const apply = args[0] === '--apply';
  const backup = apply && args.length === 3 && args[1] === '--backup' ? args[2] : undefined;
  if (!(args.length === 1 && args[0] === '--dry-run') && !backup) throw new Error('Use --dry-run or --apply --backup PATH');
  const config = demo ? readDemoConfig(await readPrivateDemoEnvironment()).config : readConfig(process.env);
  const target = new URL(config.databaseUrl);
  if (config.nodeEnv === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error('This development format conversion refuses production or remote targets');
  }
  const database = createDatabase(config, () => {});
  try {
    const result = await upgradeContent(database.pool, { apply, ...(backup ? { backup } : {}) });
    console.log(`${apply ? 'Converted' : 'Dry run: convertible'} ${result.converted} revisions; retained ${result.documents} documents and ${result.revisions} revisions.`);
    if ('archiveSha256' in result) console.log(`Original-data archive SHA-256: ${result.archiveSha256}`);
  } finally { await database.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Content conversion failed. Stop the application, check migration/arguments and preserve the original data. No content is printed.'); process.exitCode = 1; });
}
