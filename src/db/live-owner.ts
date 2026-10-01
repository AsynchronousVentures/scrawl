// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import type pg from 'pg';

/** One collaboration process per database/schema; never return its connection to the idle pool while held. */
export async function claimLiveOwner(pool: pg.Pool) {
  const connection = await pool.connect();
  const state: { status: 'starting' | 'held' | 'closed' } = { status: 'starting' };
  let heartbeat: NodeJS.Timeout | undefined;
  let heartbeatPending = false;
  let reportLoss!: () => void;
  const lost = new Promise<void>(resolve => { reportLoss = resolve; });
  const lose = () => {
    if (state.status === 'closed') return;
    state.status = 'closed';
    clearInterval(heartbeat);
    connection.release(true);
    reportLoss();
  };
  connection.on('error', lose);
  connection.on('end', lose);

  let owner: { locked: boolean; pid: number } | undefined;
  try {
    owner = (await connection.query<{ locked: boolean; pid: number }>(
      'SELECT pg_try_advisory_lock(7242030, hashtext(current_schema())) AS locked, pg_backend_pid() AS pid',
    )).rows[0];
  } catch {
    lose();
    throw new Error('Live process ownership connection failed');
  }
  if (state.status === 'closed') throw new Error('Live process ownership connection failed');
  if (!owner?.locked) {
    state.status = 'closed';
    connection.removeListener('error', lose); connection.removeListener('end', lose);
    connection.release();
    throw new Error('Live process ownership already held');
  }
  state.status = 'held';
  heartbeat = setInterval(() => {
    if (state.status !== 'held' || heartbeatPending) return;
    heartbeatPending = true;
    void connection.query('SELECT 1').catch(lose).finally(() => { heartbeatPending = false; });
  }, 1000);
  heartbeat.unref();

  return {
    pid: owner.pid,
    lost,
    assertHeld() { if (state.status !== 'held') throw new Error('Live process ownership lost'); },
    async close() {
      if (state.status === 'closed') return;
      state.status = 'closed'; clearInterval(heartbeat);
      let destroy = false;
      try { await connection.query('SELECT pg_advisory_unlock(7242030, hashtext(current_schema()))'); }
      catch { destroy = true; }
      finally {
        connection.removeListener('error', lose); connection.removeListener('end', lose);
        connection.release(destroy);
      }
    },
  };
}
