// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { validateContent } from '../src/core/documents/content.js';
import { createDatabase } from '../src/db/client.js';
import { DEMO_DATABASE, readDemoConfig, readDemoCredentials, readPrivateDemoEnvironment, readPrivateDemoFile, demoFileExists } from './demo-config.js';
import { richDemoContent } from './demo-content.js';

const manifestPath = 'artifacts/demo/workspace.json';
const props = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };
function paragraph(id: string, text: string) {
  return { id, type: 'paragraph', props, content: [{ type: 'text', text, styles: {} }], children: [] };
}
function heading(id: string, text: string) {
  return { ...paragraph(id, text), type: 'heading', props: { ...props, level: 2 } };
}
function native(blocks: unknown[]) { return validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document: blocks }).content; }
function record(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected fixture response');
  return value as Record<string, unknown>;
}
function string(value: unknown) { if (typeof value !== 'string') throw new Error('Unexpected fixture field'); return value; }

/** Explicit, repeat-safe synthetic workspace. Never retries creates or resets data. */
export async function seedWorkspace(confirmation: string) {
  if (confirmation !== DEMO_DATABASE) throw new Error('Confirm the designated disposable database');
  const { config, identity } = readDemoConfig(await readPrivateDemoEnvironment());
  const credentials = await readDemoCredentials();
  const database = createDatabase(config, () => {});
  try {
    const result = await database.pool.query('SELECT current_database() AS name');
    if (result.rows[0]?.name !== DEMO_DATABASE) throw new Error('Unexpected fixture target');
  } finally { await database.close(); }
  let cookie = '';
  async function request(method: string, path: string, body?: unknown, etag?: string, fileName?: string) {
    const binary = Buffer.isBuffer(body);
    const response = await fetch(new URL(path, identity.origin), { method, redirect: 'error',
      headers: { origin: identity.origin, ...(cookie ? { cookie } : {}), ...(etag ? { 'if-match': etag } : {}),
        ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }),
        ...(fileName ? { 'x-file-name': encodeURIComponent(fileName) } : {}) },
      ...(body === undefined ? {} : { body: binary ? new Uint8Array(body) : JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('Fixture API request failed');
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) cookie = setCookies.map(value => value.split(';')[0]).join('; ');
    return { data: record(await response.json()), etag: response.headers.get('etag') ?? undefined };
  }
  await request('POST', '/api/auth/sign-in/email', { email: credentials.accounts.administrator.email, password: credentials.accounts.administrator.password });
  try {
    const me = (await request('GET', '/api/v1/me')).data;
    if (me.id !== credentials.accounts.administrator.id || me.role !== 'administrator') throw new Error('Fixture account mismatch');
    if (await demoFileExists(manifestPath)) {
      const manifest = record(JSON.parse(await readPrivateDemoFile(manifestPath)));
      await request('GET', `/api/v1/spaces/${string(manifest.spaceId)}`);
      const ids = manifest.documentIds;
      if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw new Error('Invalid fixture manifest');
      for (const id of ids) await request('GET', `/api/v1/documents/${id}`);
      console.log('Synthetic workspace already exists. No content, history, or credentials changed.');
      return;
    }
    const spaces = (await request('GET', '/api/v1/spaces?limit=100')).data.items;
    if (Array.isArray(spaces) && spaces.some(space => record(space).name === 'Scrawl field guide')) throw new Error('Existing workspace requires inspection');
    const space = await request('POST', '/api/v1/spaces', { name: 'Scrawl field guide' });
    const spaceId = string(space.data.id); let tag = space.etag;
    for (const role of ['editor', 'reader'] as const) {
      tag = (await request('PUT', `/api/v1/spaces/${spaceId}/members/${credentials.accounts[role].id}`, { role }, tag)).etag;
    }
    const documentIds: string[] = [];
    async function create(title: string, content: ReturnType<typeof native>) {
      const result = await request('POST', `/api/v1/spaces/${spaceId}/documents`, { title, content });
      documentIds.push(string(result.data.id)); return result;
    }
    const handbook = await create('Start here', native([
      paragraph('welcome', 'This is a synthetic workspace for exploring Scrawl. Everything here is safe to edit. Changes stay local until you press Save.'),
      heading('workflow', 'The document workflow'),
      paragraph('explicit', 'Use the slash menu to add a block. Select text for formatting, use the block handle to move or nest content, and open History to compare saved revisions. Discard changes resets your local title and body without creating a revision.'),
      heading('access', 'Working with access'),
      paragraph('roles', 'The editor can save, restore, and archive. The reader can read, browse history, and export. The outsider cannot discover this space or its documents. The administrator can manage publishing when it is explicitly enabled.'),
      heading('search', 'Find saved work'),
      paragraph('search-note', 'Search uses current saved titles and bodies. It excludes archived documents and applies your current grants before returning results. Ctrl/Cmd+K opens search outside the editor; inside the editor it keeps BlockNote\'s link shortcut.'),
      heading('model', 'What Save commits'),
      paragraph('head', 'A saved document has one current revision. Title and body changes create an immutable snapshot; restore appends another snapshot. Uploading an image adds private bytes, and Save records the reference in the revision.'),
    ]));
    const handbookId = string(handbook.data.id);
    const svg = await readFile(fileURLToPath(new URL('./demo-assets/system-overview.svg', import.meta.url)));
    const png = await sharp(svg).png().toBuffer();
    const image = (await request('POST', `/api/v1/documents/${handbookId}/attachments`, png, undefined, 'scrawl-system-overview.png')).data;
    const revision = record(handbook.data.revision);
    const content = validateContent(revision.content).content;
    content.document.push(...native([{ id: 'system-image', type: 'image', props: { url: string(image.url), name: 'scrawl-system-overview.png', caption: 'Synthetic architecture diagram. Private files follow document authorization.', previewWidth: 1000, showPreview: true }, children: [] }]).document);
    await request('PATCH', `/api/v1/documents/${handbookId}`, { content }, handbook.etag);
    await create('Your first week', native([
      paragraph('week-intro', 'Start with one small change, verify it, and leave a clear revision for the next person.'),
      heading('day-one', 'Day one'),
      ...['Read the handbook and service runbook', 'Create a practice document', 'Add a heading, checklist and table', 'Save, reload, and compare History'].map((text, index) => ({ ...paragraph(`first-${index}`, text), type: 'checkListItem', props: { ...props, checked: index === 0 } })),
      heading('team', 'Meet the team'),
      { ...paragraph('people', 'Who owns what'), type: 'toggleListItem', children: [paragraph('owners', 'Documentation owners maintain accuracy. Reviewers check the practical steps. Operators manage local accounts and access grants.')] },
      ...richDemoContent(['Use nested blocks for related steps, rather than making every document flat.']).document,
    ]));
    await create('Service runbook', native([
      paragraph('runbook-intro', 'A synthetic local runbook. These commands describe the development workflow and do not target production.'),
      heading('diagnosis', 'Triage a failed save'),
      { ...paragraph('triage', 'Check the status before trying another write'), type: 'numberedListItem', children: [paragraph('triage-body', 'A 412 means the saved version changed. Keep the local draft, inspect the latest server content separately, and reconcile deliberately. A 401 requires signing in with the same account. A 404 means access or the document is unavailable.')] },
      heading('readiness', 'Check application readiness'),
      { id: 'ready-code', type: 'codeBlock', props: { language: 'bash' }, content: [{ type: 'text', text: 'curl --fail http://127.0.0.1:3100/health/ready\nnpm run check\nnpm run test:db', styles: {} }], children: [] },
      heading('recovery', 'Restore safely'),
      paragraph('recovery-body', 'Open History, select an older revision, and choose Restore. This creates a new revision and leaves intervening history intact. Archive and unarchive change lifecycle state without changing content history.'),
      ...richDemoContent(['Verification matrix']).document,
    ]));
    await create('Release checklist', native([
      paragraph('release-intro', 'A long synthetic document for section navigation, scrolling, tables, and review.'),
      ...Array.from({ length: 12 }, (_, index) => [heading(`release-section-${index}`, ['Scope', 'Prepare', 'Review content', 'Check permissions', 'Verify migrations', 'Test concurrency', 'Inspect exports', 'Check attachments', 'Reconcile conflicts', 'Archive old guidance', 'Verify recovery', 'Record the result'][index]!),
        paragraph(`release-prose-${index}`, 'Keep the work small enough to review and test the behavior against the running application. The server checks current access before mutations and commits a new revision only when content changes. Rejected writes leave the existing head and history unchanged.'),
        paragraph(`release-notes-${index}`, 'Use explicit Save after reviewing the local draft. Navigation asks before discarding edits. Keep editing returns to the draft. Exports contain saved content, and private attachment downloads require a current authenticated grant.')]).flat(),
      ...richDemoContent(['Standard blocks and formatting stay native.']).document,
    ]));
    await create('Decisions and ownership', richDemoContent(['Use the supplied editor UI. Keep private drafts local, saved revisions immutable, and search derived from committed content.']));
    await writeFile(manifestPath, JSON.stringify({ spaceId, documentIds, startDocumentId: handbookId }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('Synthetic workspace created: five documents, native rich blocks, immutable history, and a private image.');
  } finally { await request('POST', '/api/auth/sign-out', {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs({ options: { database: { type: 'string' } }, allowPositionals: false });
  seedWorkspace(parsed.values.database ?? '').catch(() => { console.error('Workspace seed refused or failed. Existing data is preserved; inspect before retrying.'); process.exitCode = 1; });
}
