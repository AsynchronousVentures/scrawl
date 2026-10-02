// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import { claimLiveOwner } from '../../src/db/live-owner.js';

test('live process ownership is isolated, exclusive and fail-closed on actual PostgreSQL connection loss', { timeout: 15_000 }, async t => {
  const base = readConfig(process.env), url = new URL(base.databaseUrl);
  assert(base.nodeEnv !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  const owner = createDatabase(base, () => {});
  const schemas = [0, 1].map(() => 'scrawl_test_live_owner_' + randomUUID().replaceAll('-', ''));
  for (const schema of schemas) await owner.pool.query(`CREATE SCHEMA "${schema}"`);
  const databases = schemas.map(schema => { const target = new URL(url); target.searchParams.set('schema', schema);
    return createDatabase({ ...base, databaseUrl: target.href }, () => {}); });
  const leases: Awaited<ReturnType<typeof claimLiveOwner>>[] = [];
  t.after(async () => {
    for (const lease of leases) await lease.close();
    for (const database of databases) await database.close();
    for (const schema of schemas) await owner.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await owner.close();
  });
  const first = await claimLiveOwner(databases[0]!.pool); leases.push(first);
  const independent = await claimLiveOwner(databases[1]!.pool); leases.push(independent);
  await t.test('a second process in the same schema refuses ownership, while another schema remains independent', async () => {
    first.assertHeld(); independent.assertHeld();
    await assert.rejects(claimLiveOwner(databases[0]!.pool), { message: 'Live process ownership already held' });
  });
  await t.test('explicit shutdown releases ownership once and permits a clean handoff', async () => {
    await first.close(); await first.close();
    assert.throws(() => first.assertHeld(), { message: 'Live process ownership lost' });
    const replacement = await claimLiveOwner(databases[0]!.pool); leases.push(replacement);
    replacement.assertHeld(); independent.assertHeld();
  });
  await t.test('terminating only the owned lease backend signals loss and permits recovery without reusing the failed session', async () => {
    const active = leases[2]!;
    const terminated = await owner.pool.query<{ stopped: boolean }>('SELECT pg_terminate_backend($1) AS stopped', [active.pid]);
    assert.equal(terminated.rows[0]?.stopped, true);
    await active.lost;
    assert.throws(() => active.assertHeld(), { message: 'Live process ownership lost' });
    await active.close();
    const recovered = await claimLiveOwner(databases[0]!.pool); leases.push(recovered);
    assert.notEqual(recovered.pid, active.pid); recovered.assertHeld(); independent.assertHeld();
  });
});
