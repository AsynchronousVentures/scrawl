// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { validateContent } from '../../src/core/documents/content.js';
import type { DemoRole } from '../../scripts/demo-config.js';
import type { DemoBResult } from '../../scripts/demo-b.js';
import type { operations } from '../../web/src/api/schema.js';
import { createBrowserDemo, type BrowserDemo } from './fixture.js';

type Document = operations['readDocument']['responses'][200]['content']['application/json'];
let demo: BrowserDemo;
let seeded: DemoBResult;

test.beforeAll(async () => { demo = await createBrowserDemo(); });
test.afterAll(async () => { await demo?.close(); });
test.beforeEach(async () => { seeded = await demo.seed(); });

function url(result = seeded) {
  return `${demo.origin}/?space=${result.spaceId}&document=${result.documentId}`;
}
function title(page: Page) { return page.getByRole('textbox', { name: 'Document title', exact: true }); }
function body(page: Page) { return page.getByRole('textbox', { name: 'Document body', exact: true }); }
function save(page: Page) { return page.getByRole('button', { name: 'Save', exact: true }); }
async function apiRequest(context: BrowserContext, path: string, options: Parameters<APIRequestContext['fetch']>[1] = {}) {
  try { return await context.request.fetch(demo.origin + path, options); }
  catch {
    // Failed Playwright API calls can include cookie headers in their rich diagnostics.
    throw new Error('The real API request could not complete');
  }
}
async function cannotSave(page: Page) {
  if (await save(page).count()) await expect(save(page)).toBeDisabled();
  else await expect(save(page)).toHaveCount(0);
}

async function signIn(page: Page, role: DemoRole) {
  const password = page.getByLabel('Password', { exact: true });
  await demo.fillCredentials(page.getByLabel('Email', { exact: true }), password, role);
  try {
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  } finally {
    demo.authenticationCompleted();
    // Playwright's automatic failure context can capture input values even with tracing off.
    if (await password.isVisible()) await password.fill('');
  }
}

async function login(page: Page, role: DemoRole = 'editor', location = url()) {
  await page.goto(location);
  await signIn(page, role);
}

async function readDocument(context: BrowserContext, id = seeded.documentId) {
  const response = await apiRequest(context, `/api/v1/documents/${id}`);
  expect(response.status()).toBe(200);
  const value: unknown = await response.json();
  if (value === null || typeof value !== 'object' || !('id' in value) || value.id !== id
    || !('revision' in value) || value.revision === null || typeof value.revision !== 'object') {
    throw new Error('The real API returned an invalid document snapshot');
  }
  const etag = response.headers().etag;
  expect(etag).toMatch(/^"doc-[0-9a-f-]+-v[1-9][0-9]*"$/i);
  return { data: value as Document, etag: etag! };
}

async function explicitSave(page: Page) {
  const response = page.waitForResponse(response => response.request().method() === 'PATCH'
    && /\/api\/v1\/documents\/[0-9a-f-]+$/.test(new URL(response.url()).pathname));
  await save(page).click();
  expect((await response).status()).toBe(200);
  await expect(save(page)).toBeDisabled();
  await expect(page.getByText(/^Saved(?:\b|$)/).first()).toBeVisible();
}

async function actions(page: Page) {
  if (!await page.getByRole('button', { name: 'Export JSON', exact: true }).isVisible()) {
    await page.locator('summary[aria-label="Document actions"]').click();
  }
}

async function assertNoBrowserPersistence(page: Page) {
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })))
    .toEqual({ local: [], session: [] });
}

async function evidence(page: Page, name: 'editing' | 'conflict' | 'history' | 'access-loss' | 'mobile') {
  if (process.env.SCRAWL_BROWSER_EVIDENCE !== '1') return;
  const password = page.getByLabel('Password', { exact: true });
  if (await password.isVisible() && await password.inputValue() !== '') {
    throw new Error('Screenshot refused while private credentials are present');
  }
  await mkdir('artifacts/browser-evidence', { recursive: true, mode: 0o700 });
  await page.screenshot({ path: `artifacts/browser-evidence/${name}.png`, fullPage: false });
}

test('keyboard login/logout uses real sessions and protected same-origin responses', async ({ page, context }) => {
  await page.goto(url());
  const email = page.getByLabel('Email', { exact: true });
  const password = page.getByLabel('Password', { exact: true });
  await email.focus();
  await expect(email).toBeFocused();
  await demo.fillCredentials(email, password, 'editor');
  await password.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeFocused();
  try {
    await page.keyboard.press('Enter');
    await expect(title(page)).toHaveValue('Release checklist');
  } finally { demo.authenticationCompleted(); if (await password.isVisible()) await password.fill(''); }
  expect((await apiRequest(context, '/api/v1/me')).status()).toBe(200);
  const protectedWrite = await apiRequest(context, `/api/v1/documents/${seeded.documentId}`, {
    method: 'PATCH', headers: { Origin: 'http://unrelated.example.test' }, data: { title: 'Wrong origin' },
  });
  expect(protectedWrite.status()).toBe(403);
  const cookies = await context.cookies();
  expect(cookies.length).toBeGreaterThan(0);
  expect(cookies.every(cookie => cookie.httpOnly && cookie.sameSite === 'Lax')).toBe(true);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  await assertNoBrowserPersistence(page);
  await page.getByRole('button', { name: 'Log out', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  expect((await apiRequest(context, '/api/v1/me')).status()).toBe(401);
});

test('create, edit, explicit save and reload persist the real selected revision', async ({ page, context }) => {
  await login(page);
  await expect(title(page)).toHaveValue('Release checklist');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await title(page).fill('Deployment checklist');
  await body(page).fill('Check tests and migrations before deployment.');
  await expect(page.getByText(/Unsaved changes/).first()).toBeVisible();
  const created = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/spaces/${seeded.spaceId}/documents`);
  await save(page).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const initial: unknown = await response.json();
  if (initial === null || typeof initial !== 'object' || !('id' in initial) || typeof initial.id !== 'string') {
    throw new Error('The API did not return a created document ID');
  }
  await expect(save(page)).toBeDisabled();
  await title(page).fill('Deployment checklist updated');
  await body(page).fill('Check tests, migrations, and the backup.');
  await explicitSave(page);
  const before = await readDocument(context, initial.id);
  expect(before.data.currentRevisionNumber).toBe(2);
  expect(before.data.revision.title).toBe('Deployment checklist updated');
  expect(before.data.revision.plainText).toBe('Check tests, migrations, and the backup.');
  await page.reload();
  await expect(title(page)).toHaveValue(before.data.revision.title);
  await expect(body(page)).toHaveText(before.data.revision.plainText);
  expect((await readDocument(context, initial.id)).data.revision.id).toBe(before.data.revision.id);
  await assertNoBrowserPersistence(page);
});

test('editor round-trips every supported native node, mark and attribute without dropping content', async ({ page, context }) => {
  await login(page);
  const content = validateContent({ format: 'prosemirror-json', schemaVersion: 1, document: {
    type: 'doc', content: [
      ...[1, 2, 3, 4, 5, 6].map(level => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: `Heading ${level}` }] })),
      { type: 'paragraph', content: [
        { type: 'text', text: 'Bold italic code link', marks: [
          { type: 'bold' }, { type: 'italic' }, { type: 'code' }, { type: 'link', attrs: { href: 'https://example.test/guide' } },
        ] },
        { type: 'hardBreak', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'HTTP link', marks: [{ type: 'link', attrs: { href: 'http://example.test/guide' } }] },
        { type: 'text', text: 'Email link', marks: [{ type: 'link', attrs: { href: 'mailto:synthetic@example.test' } }] },
      ] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Bullet item' }] },
        { type: 'orderedList', attrs: { start: 7 }, content: [{ type: 'listItem', content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Nested item seven' }] },
        ] }] },
      ] }] },
      { type: 'orderedList', attrs: { start: 4 }, content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Ordered item four' }] },
      ] }] },
      { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const synthetic = true;\n' }] },
      { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'plain code' }] },
      { type: 'paragraph' },
    ],
  } }).content;
  const response = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { Origin: demo.origin }, data: { title: 'All supported content', content },
  });
  expect(response.status()).toBe(201);
  const created: unknown = await response.json();
  if (created === null || typeof created !== 'object' || !('id' in created) || typeof created.id !== 'string') {
    throw new Error('Rich native fixture creation did not return a document ID');
  }
  const before = await readDocument(context, created.id);
  await page.goto(url({ ...seeded, documentId: created.id }));
  await expect(title(page)).toHaveValue('All supported content');
  await expect(body(page).locator('h1, h2, h3, h4, h5, h6')).toHaveCount(6);
  await expect(body(page).locator('ol[start="7"]')).toHaveCount(1);
  await expect(body(page).locator('ol[start="4"]')).toHaveCount(1);
  await title(page).fill('All supported content, title edited');
  await explicitSave(page);
  const after = await readDocument(context, created.id);
  expect(after.data.revision.content).toEqual(before.data.revision.content);
  expect(after.data.currentRevisionNumber).toBe(2);
});

test('unsupported HTML paste is rejected visibly and retains the complete local draft', async ({ page, context }) => {
  await login(page);
  await title(page).fill('Local draft before paste');
  await body(page).fill('Retain this full local body.');
  const originalBody = await body(page).innerText();
  let remoteRequests = 0;
  page.on('request', request => { if (new URL(request.url()).hostname === 'example.test') remoteRequests++; });
  await body(page).evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/html', '<p>Unsupported image<img src="https://example.test/no.png"></p>');
    clipboard.setData('text/plain', 'Unsupported image');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(page.getByRole('alert').filter({ hasText: 'Paste was rejected' })).toBeVisible();
  await expect(title(page)).toHaveValue('Local draft before paste');
  await expect(body(page)).toHaveText(originalBody);
  await expect(save(page)).toBeDisabled();
  expect(remoteRequests).toBe(0);
  expect((await readDocument(context)).data.currentRevisionNumber).toBe(1);
  await body(page).fill('Retain this full local body with a valid edit.');
  await expect(save(page)).toBeEnabled();
  await explicitSave(page);
});

test('history restore appends a revision, archive preserves history, and native export matches the selected content', async ({ page, context }) => {
  await login(page);
  const first = await readDocument(context);
  await title(page).fill('Revised release checklist');
  await body(page).fill('Verify the backup before deployment.');
  await explicitSave(page);
  const second = await readDocument(context);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: /^Revision 1\b/ }).click();
  await expect(page.getByText('Run tests before deploying.', { exact: false }).last()).toBeVisible();
  await evidence(page, 'history');
  const restoredResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/restore`);
  await page.getByRole('button', { name: 'Restore revision 1', exact: true }).click();
  expect((await restoredResponse).status()).toBe(200);
  await expect(title(page)).toHaveValue(first.data.revision.title);
  const restored = await readDocument(context);
  expect(restored.data.currentRevisionNumber).toBe(3);
  expect(restored.data.revision.id).not.toBe(first.data.revision.id);
  expect(restored.data.revision.content).toEqual(first.data.revision.content);
  const history = await demo.database.prisma.documentRevision.findMany({ where: { documentId: seeded.documentId }, orderBy: { revisionNumber: 'asc' } });
  expect(history.map(revision => revision.id)).toEqual([first.data.revision.id, second.data.revision.id, restored.data.revision.id]);
  await actions(page);
  const archivedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/archive`);
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  expect((await archivedResponse).status()).toBe(200);
  await expect(page.getByText(/Archived/).first()).toBeVisible();
  await cannotSave(page);
  await actions(page);
  const unarchivedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/unarchive`);
  await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
  expect((await unarchivedResponse).status()).toBe(200);
  const current = await readDocument(context);
  expect(current.data.currentRevisionNumber).toBe(3);
  expect(current.data.lockVersion).toBe(restored.data.lockVersion + 2);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(3);
  await actions(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`scrawl-document-${seeded.documentId}.json`);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (exported === null || typeof exported !== 'object' || !('content' in exported) || !('revision' in exported)) {
    throw new Error('The browser export has an invalid envelope');
  }
  expect(Object.keys(exported).sort()).toEqual(['content', 'document', 'exportVersion', 'format', 'revision']);
  expect(validateContent(exported.content).content).toEqual(validateContent(current.data.revision.content).content);
  expect(exported.revision).toEqual({
    id: current.data.revision.id, revisionNumber: 3, title: current.data.revision.title,
    createdAt: current.data.revision.createdAt, authorId: current.data.revision.authorId,
  });
  expect(JSON.stringify(exported)).not.toMatch(/"(?:password|token|session|account|email|cookie)"\s*:/i);
});

test('reader controls are read-only and real API denies every mutation', async ({ page, context }) => {
  await login(page, 'reader');
  await expect(title(page)).toHaveValue('Release checklist');
  await expect(title(page)).toHaveAttribute('readonly', '');
  await expect(body(page)).toHaveAttribute('contenteditable', 'false');
  await cannotSave(page);
  const newDocument = page.getByRole('button', { name: 'New document', exact: true });
  expect(await newDocument.count() === 0 || await newDocument.isDisabled()).toBe(true);
  const original = await readDocument(context);
  for (const [method, path, data] of [
    ['PATCH', '', { title: 'Reader cannot save' }],
    ['POST', '/restore', { revisionId: original.data.revision.id }],
    ['POST', '/archive', {}], ['POST', '/unarchive', {}],
  ] as const) {
    const response = await apiRequest(context, `/api/v1/documents/${seeded.documentId}${path}`, {
      method, headers: { Origin: demo.origin, 'If-Match': original.etag }, data,
    });
    expect(response.status()).toBe(404);
  }
  expect((await readDocument(context)).data).toEqual(original.data);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  const exported = await apiRequest(context, `/api/v1/documents/${seeded.documentId}/export`);
  expect(exported.status()).toBe(200);
});

test('outsider sees an empty private interface and cannot discover document, history or export', async ({ page, context }) => {
  await login(page, 'outsider', demo.origin);
  await expect(page.getByText(/No accessible spaces/).first()).toBeVisible();
  await expect(page.getByText('Release checklist', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Run tests before deploying.', { exact: false })).toHaveCount(0);
  for (const path of [
    `/api/v1/spaces/${seeded.spaceId}/documents`, `/api/v1/documents/${seeded.documentId}`,
    `/api/v1/documents/${seeded.documentId}/revisions`,
    `/api/v1/documents/${seeded.documentId}/revisions/${seeded.revisionId}`,
    `/api/v1/documents/${seeded.documentId}/export`,
  ]) {
    const response = await apiRequest(context, path);
    expect(response.status()).toBe(404);
    const problem: unknown = await response.json();
    if (problem === null || typeof problem !== 'object') throw new Error('Invalid private denial response');
    expect(Object.keys(problem).sort()).toEqual(['code', 'requestId', 'status', 'title', 'type']);
    expect(response.headers().etag).toBeUndefined();
    expect(JSON.stringify(problem)).not.toContain('Release checklist');
  }
  await assertNoBrowserPersistence(page);
});

test('two tabs preserve complete local work on 412 and require deliberate reconciliation before another save', async ({ page, context }) => {
  await login(page);
  const second = await context.newPage();
  try {
    await second.goto(url());
    await expect(title(second)).toHaveValue('Release checklist');
    const original = await readDocument(context);
    await title(page).fill('First tab server title');
    await body(page).fill('First tab committed body.');
    await title(second).fill('Second tab local title');
    await body(second).fill('Second tab complete unsaved body.\nAnother local paragraph.');
    const localBody = await body(second).innerText();
    await explicitSave(page);
    const winner = await readDocument(context);
    let staleWrites = 0;
    const sentEtags: Array<string | undefined> = [];
    const sentDrafts: unknown[] = [];
    second.on('request', request => {
      if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/v1/documents/${seeded.documentId}`) {
        staleWrites++;
        sentEtags.push(request.headers()['if-match']);
        sentDrafts.push(JSON.parse(request.postData() ?? 'null') as unknown);
      }
    });
    const stale = second.waitForResponse(response => response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}`);
    await save(second).click();
    expect((await stale).status()).toBe(412);
    await expect(second.getByRole('heading', { name: 'Save conflict', exact: true })).toBeVisible();
    await expect(title(second)).toHaveValue('Second tab local title');
    await expect(body(second)).toHaveText(localBody, { useInnerText: true });
    await expect(second.getByText(winner.data.revision.title, { exact: true }).last()).toBeVisible();
    await expect(second.getByText(winner.data.revision.plainText, { exact: true }).last()).toBeVisible();
    await expect(save(second)).toBeDisabled();
    await evidence(second, 'conflict');
    expect(staleWrites).toBe(1);
    expect(sentEtags).toEqual([original.etag]);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
    await second.getByRole('button', { name: 'Use server version', exact: true }).click();
    const discard = second.getByRole('dialog', { name: 'Unsaved changes', exact: true });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(title(second)).toHaveValue('Second tab local title');
    await expect(body(second)).toHaveText(localBody, { useInnerText: true });
    await second.getByRole('button', { name: 'Use my changes', exact: true }).click();
    await expect(title(second)).toHaveValue('Second tab local title');
    await expect(body(second)).toHaveText(localBody, { useInnerText: true });
    await expect(save(second)).toBeEnabled();
    expect(staleWrites).toBe(1);
    await explicitSave(second);
    expect(staleWrites).toBe(2);
    expect(sentEtags).toEqual([original.etag, winner.etag]);
    expect(sentDrafts[1]).toEqual(sentDrafts[0]);
    const reconciled = await readDocument(context);
    expect(reconciled.data.currentRevisionNumber).toBe(3);
    expect(reconciled.data.revision.title).toBe('Second tab local title');
    const localDraft = sentDrafts[0];
    if (localDraft === null || typeof localDraft !== 'object' || !('content' in localDraft)) {
      throw new Error('The local save did not include complete native content');
    }
    expect(reconciled.data.revision.content).toEqual(validateContent(localDraft.content).content);
    await assertNoBrowserPersistence(second);
  } finally { await second.close(); }
});

test('dirty navigation keeps edits until an explicit discard and warns before reload', async ({ page }) => {
  const anotherSpace = await demo.seed();
  await login(page);
  await title(page).fill('Unsaved local title');
  await body(page).fill('Keep this unsaved body.');
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await page.getByRole('combobox', { name: 'Space', exact: true }).selectOption(anotherSpace.spaceId);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveValue(seeded.spaceId);
  await expect(title(page)).toHaveValue('Unsaved local title');
  await expect(body(page)).toHaveText('Keep this unsaved body.');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(title(page)).toHaveValue('Unsaved local title');
  await expect(body(page)).toHaveText('Keep this unsaved body.');
  await body(page).click();
  let warned = false;
  page.once('dialog', async nativeDialog => {
    warned = nativeDialog.type() === 'beforeunload';
    await nativeDialog.dismiss();
  });
  try { await page.reload({ timeout: 5_000 }); } catch { /* Dismissing beforeunload aborts this navigation. */ }
  expect(warned).toBe(true);
  await expect(title(page)).toHaveValue('Unsaved local title');
  await expect(body(page)).toHaveText('Keep this unsaved body.');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(title(page)).not.toHaveValue('Unsaved local title');
  await expect(body(page)).not.toHaveText('Keep this unsaved body.');
});

test('a failed save retains the title/body, does not retry, and never reports success', async ({ page, context }) => {
  await login(page);
  await title(page).fill('Unsaved after failure');
  await body(page).fill('This complete body must survive the failed request.');
  let attempts = 0;
  await page.route(`**/api/v1/documents/${seeded.documentId}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    attempts++;
    await route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({
      type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'INTERNAL_ERROR', requestId: 'browser-fault',
    }) });
  });
  await save(page).click();
  await expect(page.getByRole('alert').filter({ hasText: /save|request/i }).first()).toBeVisible();
  await expect(title(page)).toHaveValue('Unsaved after failure');
  await expect(body(page)).toHaveText('This complete body must survive the failed request.');
  await expect(save(page)).toBeEnabled();
  expect(attempts).toBe(1);
  expect((await readDocument(context)).data.currentRevisionNumber).toBe(1);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  await expect(page.getByText(/^Saved(?:\b|$)/)).toHaveCount(0);
  await page.unroute(`**/api/v1/documents/${seeded.documentId}`);
  await explicitSave(page);
  expect((await readDocument(context)).data.currentRevisionNumber).toBe(2);
});

test('an expired real session leaves unsaved work intact and does not report a successful save', async ({ page }) => {
  await login(page);
  await title(page).fill('Unsaved after session expiry');
  await body(page).fill('Keep this body when the session expires.');
  await demo.database.prisma.session.updateMany({
    where: { userId: demo.accountId('editor') }, data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const failed = page.waitForResponse(response => response.request().method() === 'PATCH'
    && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}`);
  await save(page).click();
  expect((await failed).status()).toBe(401);
  await expect(title(page)).toHaveValue('Unsaved after session expiry');
  await expect(body(page)).toHaveText('Keep this body when the session expires.');
  await expect(page.getByRole('alert').filter({ hasText: /session|log in|sign in/i }).first()).toBeVisible();
  await expect(page.getByText(/^Saved(?:\b|$)/)).toHaveCount(0);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
});

test('session expiry before a first save retains a new draft through deliberate sign-in and creation', async ({ page, context }) => {
  await login(page);
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await title(page).fill('New draft after session expiry');
  await body(page).fill('Keep the entire new document until it is explicitly created.');
  await demo.database.prisma.session.updateMany({
    where: { userId: demo.accountId('editor') }, data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expired = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/spaces/${seeded.spaceId}/documents`);
  await save(page).click();
  expect((await expired).status()).toBe(401);
  await expect(title(page)).toHaveValue('New draft after session expiry');
  await expect(body(page)).toHaveText('Keep the entire new document until it is explicitly created.');
  await expect(page.getByText(/^Saved(?:\b|$)/)).toHaveCount(0);
  expect(await demo.database.prisma.document.count({ where: { spaceId: seeded.spaceId } })).toBe(1);
  await signIn(page, 'editor');
  await expect(title(page)).toHaveValue('New draft after session expiry');
  await expect(body(page)).toHaveText('Keep the entire new document until it is explicitly created.');
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveValue(seeded.spaceId);
  await expect(save(page)).toBeEnabled();
  await expect(page.getByText(/^Saved(?:\b|$)/)).toHaveCount(0);
  const created = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/spaces/${seeded.spaceId}/documents`);
  await save(page).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const value: unknown = await response.json();
  if (value === null || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') {
    throw new Error('The reconciled new draft did not return a document ID');
  }
  const current = await readDocument(context, value.id);
  expect(current.data.revision.title).toBe('New draft after session expiry');
  expect(current.data.revision.plainText).toBe('Keep the entire new document until it is explicitly created.');
  expect(await demo.database.prisma.document.count({ where: { spaceId: seeded.spaceId } })).toBe(2);
});

test('a mismatched space/document query cannot grant editor controls for a reader-only document', async ({ page, context, browser }) => {
  const readerSpace = await demo.seed();
  const administratorContext = await browser.newContext();
  try {
    const administratorPage = await administratorContext.newPage();
    await login(administratorPage, 'administrator', url(readerSpace));
    const original = await readDocument(administratorContext, readerSpace.documentId);
    const updated = await apiRequest(administratorContext, `/api/v1/documents/${readerSpace.documentId}`, {
      method: 'PATCH', headers: { Origin: demo.origin, 'If-Match': original.etag },
      data: { title: 'Reader-only other-space document', content: validateContent({ format: 'prosemirror-json', schemaVersion: 1,
        document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this body out of the wrong space pane.' }] }] },
      }).content },
    });
    expect(updated.status()).toBe(200);
    const space = await apiRequest(administratorContext, `/api/v1/spaces/${readerSpace.spaceId}`);
    expect(space.status()).toBe(200);
    const downgrade = await apiRequest(administratorContext,
      `/api/v1/spaces/${readerSpace.spaceId}/members/${demo.accountId('editor')}`, {
        method: 'PUT', headers: { Origin: demo.origin, 'If-Match': space.headers().etag! }, data: { role: 'reader' },
      });
    expect(downgrade.status()).toBe(200);
    await login(page, 'editor', url({ ...seeded, documentId: readerSpace.documentId }));
    await expect(page.getByRole('alert').filter({ hasText: 'Access to this document is unavailable' })).toBeVisible();
    await expect(title(page)).toHaveCount(0);
    await expect(body(page)).toHaveCount(0);
    await expect(page.getByText('Reader-only other-space document', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Keep this body out of the wrong space pane.', { exact: false })).toHaveCount(0);
    await cannotSave(page);
    // Access to B is still a real reader grant; the mismatch is a UI context rejection.
    expect((await apiRequest(context, `/api/v1/documents/${readerSpace.documentId}`)).status()).toBe(200);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: readerSpace.documentId } })).toBe(2);
  } finally { await administratorContext.close(); }
});

test('membership revocation blocks an existing browser session without losing its local draft', async ({ page, context, browser }) => {
  await login(page);
  const cookieCount = (await context.cookies()).length;
  await title(page).fill('Unsaved after revocation');
  await body(page).fill('The local draft survives revoked access.');
  const administratorContext = await browser.newContext();
  try {
    const administratorPage = await administratorContext.newPage();
    await login(administratorPage, 'administrator');
    const space = await apiRequest(administratorContext, `/api/v1/spaces/${seeded.spaceId}`);
    expect(space.status()).toBe(200);
    const revoked = await apiRequest(administratorContext,
      `/api/v1/spaces/${seeded.spaceId}/members/${demo.accountId('editor')}`, {
        method: 'DELETE', headers: { Origin: demo.origin, 'If-Match': space.headers().etag! },
      });
    expect(revoked.status()).toBe(200);
    const failed = page.waitForResponse(response => response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}`);
    await save(page).click();
    expect((await failed).status()).toBe(404);
    await expect(title(page)).toHaveValue('Unsaved after revocation');
    await expect(body(page)).toHaveText('The local draft survives revoked access.');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.getByText(/^Saved(?:\b|$)/)).toHaveCount(0);
    await evidence(page, 'access-loss');
    expect((await apiRequest(context, '/api/v1/me')).status()).toBe(200);
    expect((await context.cookies()).length).toBe(cookieCount);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  } finally { await administratorContext.close(); }
});

test('loading, safe read retry and empty states are visible without replacing local content', async ({ page, context }) => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  await page.route(`**/api/v1/documents/${seeded.documentId}`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await gate;
    await route.continue();
  });
  await login(page);
  await expect(page.getByText(/Loading document/).first()).toBeVisible();
  release();
  await expect(title(page)).toHaveValue('Release checklist');
  await page.unroute(`**/api/v1/documents/${seeded.documentId}`);
  await page.route(`**/api/v1/documents/${seeded.documentId}`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({
      type: 'about:blank', title: 'Service Unavailable', status: 503, code: 'SERVICE_UNAVAILABLE', requestId: 'browser-read-fault',
    }) });
  });
  await page.reload();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible();
  await page.unroute(`**/api/v1/documents/${seeded.documentId}`);
  await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
  await expect(title(page)).toHaveValue('Release checklist');
  const original = await readDocument(context);
  const archived = await apiRequest(context, `/api/v1/documents/${seeded.documentId}/archive`, {
    method: 'POST', headers: { Origin: demo.origin, 'If-Match': original.etag }, data: {},
  });
  expect(archived.status()).toBe(200);
  await page.goto(`${demo.origin}/?space=${seeded.spaceId}`);
  await expect(page.getByText(/No documents/).first()).toBeVisible();
  await page.getByLabel('Show archived', { exact: true }).check();
  await expect(page.getByRole('navigation', { name: 'Documents' }).getByRole('button', { name: /Release checklist/ })).toBeVisible();
});

test('mobile navigation is keyboard usable and stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(title(page)).toHaveValue('Release checklist');
  const outline = page.locator('details.editor-outline');
  await expect(outline).not.toHaveAttribute('open', '');
  await outline.locator('summary').click();
  await expect(page.getByRole('navigation', { name: 'On this page', exact: true }).getByRole('link').first()).toBeVisible();
  await outline.locator('summary').click();
  await expect(outline).not.toHaveAttribute('open', '');
  const navigation = page.getByRole('button', { name: 'Navigation', exact: true });
  await expect(navigation).toBeVisible();
  await navigation.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Space', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'New document', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close navigation', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).not.toBeVisible();
  await evidence(page, 'mobile');
});

test('Demo A remains executable against the same running real API', async () => {
  await demo.runDemoA();
});

test('failed recovery reads and their explicit retry preserve a dirty draft until reconciliation', async ({ page }) => {
  await login(page);
  await title(page).fill('Unsaved through recovery read failure');
  await body(page).fill('Keep this entire body through login and a failed workspace read.');
  await demo.database.prisma.session.updateMany({
    where: { userId: demo.accountId('editor') }, data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expired = page.waitForResponse(response => response.request().method() === 'PATCH'
    && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}`);
  await save(page).click();
  expect((await expired).status()).toBe(401);
  const password = page.getByLabel('Password', { exact: true });
  await demo.fillCredentials(page.getByLabel('Email', { exact: true }), password, 'outsider');
  try {
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Sign in with the account that owns this local draft.' })).toBeVisible();
  } finally {
    demo.authenticationCompleted();
    if (await password.isVisible()) await password.fill('');
  }
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveCount(0);
  await expect(title(page)).toHaveValue('Unsaved through recovery read failure');
  await expect(body(page)).toHaveText('Keep this entire body through login and a failed workspace read.');
  await cannotSave(page);
  let failedReads = 0;
  await page.route(/\/api\/v1\/spaces(?:\?|$)/, async route => {
    if (route.request().method() !== 'GET' || failedReads) return route.continue();
    failedReads++;
    await route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({
      type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'INTERNAL_ERROR', requestId: 'browser-recovery-fault',
    }) });
  });
  await signIn(page, 'editor');
  await expect(page.getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible();
  await expect(title(page)).toHaveValue('Unsaved through recovery read failure');
  await expect(body(page)).toHaveText('Keep this entire body through login and a failed workspace read.');
  expect(failedReads).toBe(1);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  await cannotSave(page);
  await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Save conflict', exact: true })).toBeVisible();
  await expect(title(page)).toHaveValue('Unsaved through recovery read failure');
  await expect(body(page)).toHaveText('Keep this entire body through login and a failed workspace read.');
  await expect(save(page)).toBeDisabled();
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  await page.getByRole('button', { name: 'Use my changes', exact: true }).click();
  await explicitSave(page);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
});

test('the outline follows actual document headings, scrolls and focuses sections, and updates after an edit', async ({ page, context }) => {
  await login(page);
  await expect(title(page)).toHaveValue('Release checklist');
  const headings = body(page).locator('h1, h2, h3, h4, h5, h6');
  const sectionNames = await headings.allTextContents();
  expect(sectionNames.length).toBeGreaterThanOrEqual(2);
  const outline = page.getByRole('navigation', { name: 'On this page', exact: true });
  await expect(outline.getByRole('link')).toHaveCount(sectionNames.length);
  for (const name of sectionNames) await expect(outline.getByRole('link', { name, exact: true })).toBeVisible();
  await evidence(page, 'editing');
  const lastName = sectionNames.at(-1)!;
  const lastLink = outline.getByRole('link', { name: lastName, exact: true });
  await lastLink.focus();
  await page.keyboard.press('Enter');
  const heading = body(page).getByRole('heading', { name: lastName, exact: true });
  await expect(heading).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const position = await heading.boundingBox();
  expect(position?.y).toBeGreaterThanOrEqual(-1);
  expect(position?.y).toBeLessThan(844);
  await heading.selectText();
  await page.keyboard.insertText('Updated synthetic section');
  await expect(outline.getByRole('link', { name: 'Updated synthetic section', exact: true })).toBeVisible();
  await expect(outline.getByRole('link', { name: lastName, exact: true })).toHaveCount(0);
  await expect(body(page).getByRole('heading', { name: 'Updated synthetic section', exact: true })).toBeVisible();
  expect((await readDocument(context)).data.currentRevisionNumber).toBe(1);
  await explicitSave(page);
  const updated = await readDocument(context);
  expect(updated.data.currentRevisionNumber).toBe(2);
  expect(updated.data.revision.plainText).toContain('Updated synthetic section');
});
