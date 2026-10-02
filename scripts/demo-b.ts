// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDatabase } from '../src/db/client.js';
import { validateContent } from '../src/core/documents/content.js';
import { richDemoContent } from './demo-content.js';
import {
  DEMO_DATABASE, demoFileExists, readDemoConfig, readDemoCredentials, readPrivateDemoEnvironment,
} from './demo-config.js';

export type DemoBResult = Readonly<{
  spaceId: string;
  documentId: string;
  revisionId: string;
  revisionNumber: 1;
}>;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected demo response');
  return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Unexpected demo identifier');
  }
  return value;
}

async function resultFile() {
  for (const path of ['artifacts', 'artifacts/demo']) {
    if (!await demoFileExists(path)) await mkdir(path, { mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.getuid && stat.uid !== process.getuid())
      || (path === 'artifacts/demo' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Unsafe demo artifact directory');
    }
  }
  const file = await open('artifacts/demo/b-result.json', constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe demo artifact target');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

function client(origin: string) {
  const cookies = new Map<string, string>();
  return {
    async request(method: string, path: string, status: number, body?: unknown, etag?: string) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise<{ data: Record<string, unknown>; etag: string | undefined }>((done, reject) => {
        const request = httpRequest(new URL(path, origin), {
          method, localAddress: '127.0.0.67',
          headers: {
            origin,
            ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
            ...(etag ? { 'if-match': etag } : {}),
          },
        }, response => {
          for (const cookie of response.headers['set-cookie'] ?? []) {
            const first = cookie.split(';')[0] ?? '';
            const separator = first.indexOf('=');
            if (separator < 1) continue;
            const name = first.slice(0, separator);
            const value = first.slice(separator + 1);
            if (value) cookies.set(name, value); else cookies.delete(name);
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) request.destroy(new Error('Demo response too large'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              if (response.statusCode !== status) throw new Error('Unexpected demo response status');
              const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              done({ data: record(data), etag: response.headers.etag });
            } catch { reject(new Error('Unexpected demo response')); }
          });
        });
        request.setTimeout(15_000, () => request.destroy(new Error('Demo request timed out')));
        request.on('error', reject);
        request.end(payload);
      });
    },
  };
}

function spaceEtag(value: string | undefined): string {
  if (typeof value !== 'string' || !/^"space-[0-9a-f-]+-v[1-9][0-9]*"$/i.test(value)) {
    throw new Error('Missing demo space precondition');
  }
  return value;
}

/** Explicit synthetic seed against the running API. Existing fixture accounts are required. */
export async function seedDemoB(confirmation: string): Promise<DemoBResult> {
  if (confirmation !== DEMO_DATABASE) throw new Error('Confirm the disposable database by name');
  const { config, identity } = readDemoConfig(await readPrivateDemoEnvironment());
  const credentials = await readDemoCredentials();
  const database = createDatabase(config, () => { console.error('Demo database connection failed'); });
  try {
    const target = await database.pool.query<{ database: string; user: string }>(
      'SELECT current_database() AS database, current_user AS user',
    );
    if (target.rows[0]?.database !== DEMO_DATABASE
      || target.rows[0]?.user !== decodeURIComponent(new URL(config.databaseUrl).username)) {
      throw new Error('Connected database does not match the explicit demo target');
    }
  } finally { await database.close(); }

  // Vet the fixed artifact target before making any HTTP mutations.
  const output = await resultFile();
  const api = client(identity.origin);
  let signedIn = false;
  try {
    await api.request('GET', '/health/ready', 200);
    await api.request('POST', '/api/auth/sign-in/email', 200, {
      email: credentials.accounts.administrator.email, password: credentials.accounts.administrator.password,
    });
    signedIn = true;
    const me = (await api.request('GET', '/api/v1/me', 200)).data;
    if (me.id !== credentials.accounts.administrator.id || me.role !== 'administrator') {
      throw new Error('The running API does not match the private fixture administrator');
    }
    const space = await api.request('POST', '/api/v1/spaces', 201, { name: 'Demo B handbook' });
    const spaceId = uuid(space.data.id);
    let tag = spaceEtag(space.etag);
    for (const role of ['editor', 'reader'] as const) {
      const granted = await api.request('PUT', `/api/v1/spaces/${spaceId}/members/${credentials.accounts[role].id}`,
        200, { role }, tag);
      tag = spaceEtag(granted.etag);
    }
    const textProps = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };
    const content = validateContent({
      format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document: [
        { id: 'demo-checklist-1', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Run tests before deploying.', styles: {} }], children: [] },
        { id: 'demo-checklist-2', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Save changes explicitly and keep revision history.', styles: {} }], children: [] },
        { id: 'demo-checklist-3', type: 'heading', props: { ...textProps, level: 2 }, content: [{ type: 'text', text: 'Before you start', styles: {} }], children: [] },
        { id: 'demo-checklist-4', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Use the disposable demo database and synthetic accounts for this checklist. Confirm which space you are working in before making a change. The editor and reader accounts have different permissions; the outsider account has no access to this handbook.', styles: {} }], children: [] },
        { id: 'demo-checklist-5', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Keep the intended change small enough to review. Write down the expected result, the checks you will run, and the conditions that would make you stop. This document is a practice fixture, so no production data or real credentials belong here.', styles: {} }], children: [] },
        { id: 'demo-checklist-6', type: 'heading', props: { ...textProps, level: 2 }, content: [{ type: 'text', text: 'Review the change', styles: {} }], children: [] },
        { id: 'demo-checklist-7', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Read the current title and body before editing. Check the document history when you need to understand an earlier decision. A revision is an immutable snapshot, and restoring a snapshot creates another revision rather than changing the original.', styles: {} }], children: [] },
        { id: 'demo-checklist-8', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Use headings to make a longer checklist easy to scan. The outline on this page follows the headings in the document itself. Choose a section in the outline to move directly to it, then return to the top when you need the document actions.', styles: {} }], children: [] },
        { id: 'demo-checklist-9', type: 'heading', props: { ...textProps, level: 2 }, content: [{ type: 'text', text: 'Verify the build', styles: {} }], children: [] },
        { id: 'demo-checklist-10', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Run the foundation checks and the database tests before considering the change ready. A passing interface check does not replace a transaction or authorization check. Record the exact command and the observed result so another person can repeat it.', styles: {} }], children: [] },
        { id: 'demo-checklist-11', type: 'heading', props: { ...textProps, level: 3 }, content: [{ type: 'text', text: 'Check the browser', styles: {} }], children: [] },
        { id: 'demo-checklist-12', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Log in, make a small edit, save explicitly, and reload. Confirm that the saved title and body return from the API. Use the keyboard to reach navigation, editor controls, history, and the document menu. Focus should remain visible throughout.', styles: {} }], children: [] },
        { id: 'demo-checklist-13', type: 'heading', props: { ...textProps, level: 2 }, content: [{ type: 'text', text: 'Check permissions', styles: {} }], children: [] },
        { id: 'demo-checklist-14', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'A reader can open the document, browse history, and export the saved snapshot. Editing and lifecycle actions require editor access. An outsider must not learn the title, body, or revision numbers, even when requesting a known document identifier.', styles: {} }], children: [] },
        { id: 'demo-checklist-15', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'After membership is revoked, the existing session can still identify its account but cannot use the removed space access. If a save discovers that access is lost, retain the unsaved draft in the tab and remove the unavailable server actions.', styles: {} }], children: [] },
        { id: 'demo-checklist-16', type: 'heading', props: { ...textProps, level: 2 }, content: [{ type: 'text', text: 'Save and compare', styles: {} }], children: [] },
        { id: 'demo-checklist-17', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Open this document in two tabs and change both copies. Save one copy first. The other copy should report a conflict, retain its complete local title and body, and show the latest server version separately. Reconcile deliberately before pressing Save again.', styles: {} }], children: [] },
        { id: 'demo-checklist-18', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'A temporary failure is different from lost access. A failed request must not display a successful save. Navigation that would discard a dirty draft asks for confirmation; choose Keep editing to return to the draft without changing it.', styles: {} }], children: [] },
        { id: 'demo-checklist-19', type: 'heading', props: { ...textProps, level: 2 }, content: [{ type: 'text', text: 'History and recovery', styles: {} }], children: [] },
        { id: 'demo-checklist-20', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Compare the current revision with an earlier snapshot in History. Restoring the older snapshot appends a new revision with the restored title and body. The intervening revisions remain readable, and the content revision number advances only when a snapshot is created.', styles: {} }], children: [] },
        { id: 'demo-checklist-21', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Unsaved drafts remain only in the current browser tab. They are not stored in local storage or a background autosave service. If a session expires, copy the retained draft before closing or reloading, or log in with the same account and review it before saving.', styles: {} }], children: [] },
        { id: 'demo-checklist-22', type: 'heading', props: { ...textProps, level: 2 }, content: [{ type: 'text', text: 'Archive and export', styles: {} }], children: [] },
        { id: 'demo-checklist-23', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Archive removes a document from the default list and makes its body read-only. Show archived to find it again, then unarchive deliberately. These lifecycle actions preserve the content history while advancing the separate document lock version.', styles: {} }], children: [] },
        { id: 'demo-checklist-24', type: 'paragraph', props: textProps, content: [{ type: 'text', text: 'Export JSON downloads the current saved snapshot with minimal document and revision provenance. Unsaved changes are excluded. This single-document native export is useful for inspection; it is not a complete history export, import system, or database backup.', styles: {} }], children: [] },
        ...richDemoContent(['Standard rich blocks keep their native structure.']).document,
      ],
    }).content;
    const created = (await api.request('POST', `/api/v1/spaces/${spaceId}/documents`, 201,
      { title: 'Release checklist', content })).data;
    const documentId = uuid(created.id);
    const revision = record(created.revision);
    if (created.spaceId !== spaceId || created.currentRevisionNumber !== 1
      || revision.documentId !== documentId || revision.revisionNumber !== 1 || revision.title !== 'Release checklist') {
      throw new Error('Unexpected seeded document');
    }
    const result: DemoBResult = { spaceId, documentId, revisionId: uuid(revision.id), revisionNumber: 1 };
    await api.request('POST', '/api/auth/sign-out', 200, {});
    signedIn = false;
    await output.truncate(0);
    await output.writeFile(JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    if (signedIn) {
      // Clean up the seed session even if a later HTTP assertion fails. No write is retried.
      try { await api.request('POST', '/api/auth/sign-out', 200, {}); } catch { /* Cookie stays only in this process. */ }
    }
    await output.close();
  }
}

async function main() {
  const { values } = parseArgs({ options: { database: { type: 'string' } }, allowPositionals: false });
  if (values.database !== DEMO_DATABASE) throw new Error('Use --database scrawl_demo_a');
  const result = await seedDemoB(values.database);
  console.log(`Demo B seeded. Space ${result.spaceId}; document ${result.documentId}; revision 1. IDs: artifacts/demo/b-result.json`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    // Transport and library errors can include private values, so never print their details.
    console.error('Demo B seed failed. Check explicit database confirmation, private fixture configuration, and the running demo API. Reset and provisioning are always separate commands.');
    process.exitCode = 1;
  });
}
