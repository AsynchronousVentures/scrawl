// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { validateContent } from '../../src/core/documents/content.js';
import type { ContentEnvelope } from '../../src/shared/content.js';
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
  expect(etag).toMatch(/^"doc-[0-9a-f-]+-bn1-v[1-9][0-9]*"$/i);
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
  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage), session: Object.entries(sessionStorage),
  }));
  expect(stored.session).toEqual([]);
  // Native toggles remember only expansion booleans, never a document body/title.
  for (const [key, value] of stored.local) {
    expect(key).toMatch(/^toggle-[A-Za-z0-9_-]+$/);
    expect(['true', 'false']).toContain(value);
  }
}

function formatting(page: Page) { return page.locator('.editor-content > .editor-mount .bn-formatting-toolbar').first(); }
function discardChanges(page: Page) { return page.getByRole('button', { name: 'Discard changes', exact: true }); }

const textProps = { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' };
const text = (value: string, styles: Record<string, string | boolean> = {}) => ({ type: 'text', text: value, styles });
const paragraph = (id: string, value: string) => ({ id, type: 'paragraph', props: textProps, content: [text(value)], children: [] });
function nativeContent(document: unknown[]): ContentEnvelope {
  return validateContent({ format: 'blocknote-json', schemaVersion: 1, editorVersion: '0.55.0', document }).content;
}
async function slashBlock(page: Page, query: string, title: string) {
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`/${query}`);
  await page.getByRole('option', { name: new RegExp(`^${title}\\b`) }).click();
}

async function confirmDiscard(page: Page) {
  await discardChanges(page).click();
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function evidence(page: Page, name: 'editing' | 'conflict' | 'history' | 'access-loss' | 'mobile'
  | 'editor-toolbar' | 'link-editor' | 'discard-changes') {
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

test('editor round-trips native standard blocks, styles, nesting, media placeholders and table cells', async ({ page, context }) => {
  await login(page);
  const content = nativeContent([
    ...[1, 2, 3, 4, 5, 6].map(level => ({ id: `native-heading-${level}`, type: 'heading', props: { ...textProps, level }, content: [text(`Heading ${level}`)], children: [] })),
    { id: 'native-styles', type: 'paragraph', props: textProps, content: [
      text('Bold italic underline strike', { bold: true, italic: true, underline: true, strike: true }),
      text(' Highlights ', { textColor: 'green', backgroundColor: 'yellow' }), text('Line one\nLine two '),
      { type: 'link', href: 'https://example.test/guide', content: [text('HTTP guide')] },
      { type: 'link', href: 'mailto:synthetic@example.test', content: [text('Email guide')] },
      text('native.code', { code: true }),
    ], children: [] },
    { id: 'native-bullet', type: 'bulletListItem', props: textProps, content: [text('Bullet item')], children: [
      { id: 'native-nested-number', type: 'numberedListItem', props: { ...textProps, start: 7 }, content: [text('Nested item seven')], children: [] },
    ] },
    { id: 'native-number', type: 'numberedListItem', props: { ...textProps, start: 4 }, content: [text('Ordered item four')], children: [] },
    { id: 'native-check', type: 'checkListItem', props: { ...textProps, checked: true }, content: [text('Checked item')], children: [] },
    { id: 'native-toggle', type: 'toggleListItem', props: textProps, content: [text('Toggle notes')], children: [
      { id: 'native-nested-heading', type: 'heading', props: { ...textProps, level: 3 }, content: [text('Nested heading')], children: [] },
    ] },
    { id: 'native-quote', type: 'quote', props: { backgroundColor: 'default', textColor: 'default' }, content: [text('A native quotation.')], children: [] },
    { id: 'native-table', type: 'table', props: { textColor: 'default' }, content: {
      type: 'tableContent', columnWidths: [140, 160], headerRows: 1, rows: [
        { cells: ['Check', 'Result'].map(value => ({ type: 'tableCell', props: { ...textProps, colspan: 1, rowspan: 1 }, content: [text(value)] })) },
        { cells: ['Round trip', 'Retained'].map(value => ({ type: 'tableCell', props: { ...textProps, colspan: 1, rowspan: 1 }, content: [text(value, { bold: true })] })) },
      ],
    }, children: [] },
    { id: 'native-code', type: 'codeBlock', props: { language: 'typescript' }, content: [text('const synthetic = true;\n')], children: [] },
    { id: 'native-divider', type: 'divider', props: {}, children: [] },
    ...['image', 'video'].map(type => ({ id: `native-${type}`, type, props: { textAlignment: 'left', backgroundColor: 'default', name: '', url: '', caption: '', showPreview: true }, children: [] })),
    { id: 'native-audio', type: 'audio', props: { backgroundColor: 'default', name: '', url: '', caption: '', showPreview: true }, children: [] },
    { id: 'native-file', type: 'file', props: { backgroundColor: 'default', name: '', url: '', caption: '' }, children: [] },
    paragraph('native-end', ''),
  ]);
  const response = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { Origin: demo.origin }, data: { title: 'Native BlockNote content', content },
  });
  expect(response.status()).toBe(201);
  const created: unknown = await response.json();
  if (created === null || typeof created !== 'object' || !('id' in created) || typeof created.id !== 'string') {
    throw new Error('Native fixture creation did not return a document ID');
  }
  const before = await readDocument(context, created.id);
  await page.goto(url({ ...seeded, documentId: created.id }));
  await expect(title(page)).toHaveValue('Native BlockNote content');
  await expect(body(page).locator('h1,h2,h3,h4,h5,h6')).toHaveCount(7);
  await expect(body(page).getByRole('table')).toHaveCount(1);
  await expect(body(page).getByRole('columnheader')).toHaveCount(2);
  await expect(body(page).locator('u')).toHaveText('Bold italic underline strike');
  await body(page).locator('[data-id="native-end"] p').last().click();
  await page.keyboard.insertText('Temporary native round-trip edit');
  await expect(body(page).locator('[data-id="native-end"] p').last()).toHaveText('Temporary native round-trip edit');
  await expect(save(page)).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(body(page).locator('[data-id="native-end"] p').last()).toHaveText('');
  await expect(save(page)).toBeDisabled();
  await title(page).fill('Native BlockNote content, title edited');
  await explicitSave(page);
  const after = await readDocument(context, created.id);
  expect(after.data.revision.content).toEqual(before.data.revision.content);
  expect(after.data.currentRevisionNumber).toBe(2);
  await assertNoBrowserPersistence(page);
});

test('normal rich HTML paste preserves underline, quote and table content through a real save', async ({ page, context }) => {
  await login(page);
  await title(page).fill('Native rich paste');
  await body(page).fill('');
  await body(page).evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/html', '<p><u>Underlined synthetic text</u></p><blockquote>A native quote</blockquote><table><tbody><tr><td>Check</td><td>Result</td></tr><tr><td>Rich paste</td><td>Retained</td></tr></tbody></table>');
    clipboard.setData('text/plain', 'Underlined synthetic text\nA native quote\nCheck Result\nRich paste Retained');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(body(page).locator('u')).toHaveText('Underlined synthetic text');
  await expect(body(page).getByRole('table')).toHaveCount(1);
  await expect(body(page).getByRole('cell', { name: 'Retained', exact: true })).toBeVisible();
  await expect(save(page)).toBeEnabled();
  expect((await readDocument(context)).data.currentRevisionNumber).toBe(1);
  await explicitSave(page);
  const saved = await readDocument(context);
  const native = validateContent(saved.data.revision.content).content;
  expect(native.format).toBe('blocknote-json');
  expect(native.editorVersion).toBe('0.55.0');
  expect(native.document.map(block => block.type)).toContain('table');
  expect(native.document.map(block => block.type)).toContain('quote');
  expect(saved.data.revision.plainText).toContain('Underlined synthetic text');
  expect(saved.data.revision.plainText).toContain('Retained');
  await page.reload();
  await expect(title(page)).toHaveValue('Native rich paste');
  await expect(body(page).locator('u')).toHaveText('Underlined synthetic text');
  await expect(body(page).getByRole('cell', { name: 'Retained', exact: true })).toBeVisible();
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
  await expect(body(page).getByRole('checkbox').first()).toBeDisabled();
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
      data: { title: 'Reader-only other-space document', content: nativeContent([paragraph('native-other-space', 'Keep this body out of the wrong space pane.')]) },
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
  await expect(body(page).locator('.bn-block-content[data-content-type="heading"]').filter({ has: heading })).toBeFocused();
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

test('nested native heading navigation opens its toggle ancestors without changing saved content', async ({ page, context }) => {
  await login(page);
  const content = nativeContent([
    paragraph('nested-intro', 'Synthetic nested outline'),
    { id: 'nested-toggle-parent', type: 'toggleListItem', props: textProps, content: [text('Closed native parent')], children: [
      { id: 'nested-toggle-child', type: 'toggleListItem', props: textProps, content: [text('Closed native child')], children: [
        { id: 'nested-target', type: 'heading', props: { ...textProps, level: 3 }, content: [text('Nested outline target')], children: [] },
      ] },
    ] },
    paragraph('nested-end', ''),
  ]);
  const created = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { Origin: demo.origin }, data: { title: 'Nested native outline', content },
  });
  expect(created.status()).toBe(201);
  const value: unknown = await created.json();
  if (value === null || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('Missing native document ID');
  const original = await readDocument(context, value.id);
  await page.goto(url({ ...seeded, documentId: value.id }));
  await expect(title(page)).toHaveValue('Nested native outline');
  const target = body(page).getByRole('heading', { name: 'Nested outline target', exact: true });
  await expect(target).not.toBeVisible();
  const link = page.getByRole('navigation', { name: 'On this page', exact: true }).getByRole('link', { name: 'Nested outline target', exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(target).toBeVisible();
  await expect(body(page).locator('.bn-block-content[data-content-type="heading"]').filter({ has: target })).toBeFocused();
  await expect(save(page)).toBeDisabled();
  expect(await readDocument(context, value.id)).toEqual(original);
  await assertNoBrowserPersistence(page);
});

test('supplied formatting controls and native undo/redo work across successful saves and first creation', async ({ page, context }) => {
  await login(page);
  await expect(title(page)).toHaveValue('Release checklist');
  await body(page).fill('Native supplied formatting');
  await body(page).locator('p').first().selectText();
  const toolbar = formatting(page);
  const bold = toolbar.getByRole('button', { name: 'Bold', exact: true });
  await expect(bold).toBeVisible();
  await bold.focus();
  await page.keyboard.press('Enter');
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await toolbar.getByRole('button', { name: 'Italic', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Underline', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Strike', exact: true }).click();
  await toolbar.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Heading 2', exact: true }).click();
  await expect(body(page).getByRole('heading', { name: 'Native supplied formatting', exact: true })).toBeVisible();
  await evidence(page, 'editor-toolbar');
  await explicitSave(page);
  const saved = await readDocument(context);
  const native = validateContent(saved.data.revision.content).content;
  expect(native.document[0]).toMatchObject({ type: 'heading', props: { level: 2 }, content: [
    { type: 'text', text: 'Native supplied formatting', styles: { bold: true, italic: true, underline: true, strike: true } },
  ] });
  const savedBody = await body(page).innerHTML();
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(save(page)).toBeEnabled();
  expect(await body(page).innerHTML()).not.toBe(savedBody);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(save(page)).toBeDisabled();
  expect(await body(page).innerHTML()).toBe(savedBody);
  expect((await readDocument(context)).data).toEqual(saved.data);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
  await page.reload();
  await expect(title(page)).toHaveValue(saved.data.revision.title);
  await expect(body(page).getByRole('heading', { name: 'Native supplied formatting', exact: true })).toBeVisible();
  await expect(body(page).locator('u')).toHaveText('Native supplied formatting');

  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await title(page).fill('Undo after first creation');
  await body(page).fill('The first saved body remains in native editor history.');
  const created = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/spaces/${seeded.spaceId}/documents`);
  await save(page).click();
  expect((await created).status()).toBe(201);
  await expect(save(page)).toBeDisabled();
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(body(page)).not.toHaveText('The first saved body remains in native editor history.');
  await expect(title(page)).toHaveValue('Undo after first creation');
  await expect(save(page)).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(body(page)).toHaveText('The first saved body remains in native editor history.');
  await expect(save(page)).toBeDisabled();
  expect(await demo.database.prisma.document.count({ where: { spaceId: seeded.spaceId } })).toBe(2);
});

test('supplied slash menu creates rich blocks and editable tables that persist natively', async ({ page, context }) => {
  await login(page);
  await body(page).fill('A native rich document');
  await slashBlock(page, 'h2', 'Heading 2');
  await page.keyboard.insertText('Created through the slash menu');
  await slashBlock(page, 'check', 'Check List');
  await page.keyboard.insertText('A real checklist item');
  await slashBlock(page, 'quote', 'Quote');
  await page.keyboard.insertText('A native quotation');
  await slashBlock(page, 'table', 'Table');
  const table = body(page).getByRole('table');
  await expect(table).toBeVisible();
  const cell = table.getByRole('cell').first();
  await cell.click();
  await page.keyboard.insertText('Native table edit');
  await expect(cell).toHaveText('Native table edit');
  await explicitSave(page);
  const saved = await readDocument(context);
  const native = validateContent(saved.data.revision.content).content;
  expect(native.document.map(block => block.type)).toEqual(expect.arrayContaining(['paragraph', 'heading', 'checkListItem', 'quote', 'table']));
  expect(saved.data.revision.plainText).toContain('Created through the slash menu');
  expect(saved.data.revision.plainText).toContain('Native table edit');
  await page.reload();
  await expect(title(page)).toHaveValue('Release checklist');
  await expect(body(page).getByRole('cell', { name: 'Native table edit', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'On this page', exact: true })
    .getByRole('link', { name: 'Created through the slash menu', exact: true })).toBeVisible();
});

test('official media embed accepts a URL, renders the image and preserves it through reload and export', async ({ page, context }) => {
  await login(page);
  const mediaURL = `${demo.origin}/synthetic-native-image.png`;
  await page.route(mediaURL, route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLXsAAAAASUVORK5CYII=', 'base64') }));
  await body(page).fill('A linked native image');
  await slashBlock(page, 'image', 'Image');
  const embed = page.getByPlaceholder('Enter URL', { exact: true });
  await expect(embed).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Upload', exact: true })).toHaveCount(0);
  await embed.fill(mediaURL);
  await page.getByRole('button', { name: 'Embed image', exact: true }).click();
  const image = body(page).locator(`img[src="${mediaURL}"]`);
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
  await explicitSave(page);
  const saved = await readDocument(context);
  expect(validateContent(saved.data.revision.content).content.document.find(block => block.type === 'image'))
    .toMatchObject({ type: 'image', props: { url: mediaURL, name: 'synthetic-native-image.png' } });
  await page.reload();
  await expect(image).toBeVisible();
  const exported = await apiRequest(context, `/api/v1/documents/${seeded.documentId}/export`);
  expect(exported.status()).toBe(200);
  const snapshot: unknown = await exported.json();
  if (snapshot === null || typeof snapshot !== 'object' || !('content' in snapshot)) throw new Error('Missing export native content');
  expect(validateContent(snapshot.content).content).toEqual(validateContent(saved.data.revision.content).content);
});

test('supplied link UI creates, edits, cancels and removes native links without silently saving', async ({ page, context }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await login(page);
  await body(page).fill('Read the synthetic release guide.');
  await body(page).locator('p').first().selectText();
  await formatting(page).getByRole('button', { name: 'Create link', exact: true }).click();
  const href = page.getByPlaceholder('Edit URL', { exact: true });
  await expect(href).toBeFocused();
  await href.fill('https://example.test/release-guide');
  await href.press('Enter');
  const anchor = body(page).getByRole('link', { name: 'Read the synthetic release guide.', exact: true });
  await expect(anchor).toHaveAttribute('href', 'https://example.test/release-guide');
  await expect(body(page)).toBeFocused();
  try { await explicitSave(page); }
  catch (error) {
    if (browserErrors.length) throw new Error(`Browser integration failed: ${browserErrors.join('; ')}`);
    throw error;
  }
  const original = await readDocument(context);
  expect(validateContent(original.data.revision.content).content.document[0]).toMatchObject({ content: [
    { type: 'link', href: 'https://example.test/release-guide', content: [{ type: 'text', text: 'Read the synthetic release guide.', styles: {} }] },
  ] });

  await body(page).locator('p').first().selectText();
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(href).toBeFocused();
  await expect(href).toHaveValue('https://example.test/release-guide');
  await evidence(page, 'link-editor');
  await href.fill('https://example.test/cancelled');
  await href.press('Escape');
  await expect(href).not.toBeVisible();
  await expect(anchor).toHaveAttribute('href', 'https://example.test/release-guide');
  expect((await readDocument(context)).data).toEqual(original.data);

  await body(page).locator('p').first().selectText();
  await page.keyboard.press('ControlOrMeta+k');
  await href.fill('mailto:synthetic@example.test');
  await href.press('Enter');
  await expect(anchor).toHaveAttribute('href', 'mailto:synthetic@example.test');
  await expect(body(page)).toHaveText('Read the synthetic release guide.');
  await explicitSave(page);
  const updated = await readDocument(context);
  expect(validateContent(updated.data.revision.content).content.document[0]).toMatchObject({ content: [
    { type: 'link', href: 'mailto:synthetic@example.test' },
  ] });
  await anchor.hover();
  const linkToolbar = page.locator('.bn-link-toolbar');
  await expect(linkToolbar.getByRole('button', { name: 'Remove link', exact: true })).toBeVisible();
  await linkToolbar.getByRole('button', { name: 'Remove link', exact: true }).click();
  await expect(body(page).getByRole('link')).toHaveCount(0);
  await expect(body(page)).toHaveText('Read the synthetic release guide.');
  await explicitSave(page);
  const unlinked = await readDocument(context);
  expect(unlinked.data.currentRevisionNumber).toBe(4);
  expect(validateContent(unlinked.data.revision.content).content.document[0]).toMatchObject({ content: [
    { type: 'text', text: 'Read the synthetic release guide.', styles: {} },
  ] });
});

test('invalid native link content stays local, blocks Save and can be undone without changing history', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context);
  await title(page).fill('Unsaved title before invalid link');
  await body(page).fill('Keep the entire local body.');
  await body(page).locator('p').first().selectText();
  await formatting(page).getByRole('button', { name: 'Create link', exact: true }).click();
  const href = page.getByPlaceholder('Edit URL', { exact: true });
  await href.fill('javascript:alert(1)');
  await href.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'cannot be saved' })).toBeVisible();
  await expect(title(page)).toHaveValue('Unsaved title before invalid link');
  await expect(body(page)).toHaveText('Keep the entire local body.');
  await expect(save(page)).toBeDisabled();
  await expect(body(page).locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await readDocument(context)).toEqual(original);
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByRole('alert').filter({ hasText: 'cannot be saved' })).toHaveCount(0);
  await expect(save(page)).toBeEnabled();
  await confirmDiscard(page);
  await expect(title(page)).toHaveValue(original.data.revision.title);
  expect(await readDocument(context)).toEqual(original);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
});

test('discard requires confirmation and resets the complete title/body baseline without a write or new revision', async ({ page, context }) => {
  await login(page);
  await expect(title(page)).toHaveValue('Release checklist');
  const baseline = await readDocument(context);
  const baselineBody = await body(page).innerText();
  const baselineHeadings = await body(page).locator('h1, h2, h3, h4, h5, h6').allTextContents();
  const toolbar = formatting(page);
  await expect(discardChanges(page)).toBeDisabled();
  await title(page).fill('Unsaved title to discard');
  await body(page).fill('The full local body is different from the baseline.');
  await body(page).locator('p').selectText();
  await toolbar.getByRole('button', { name: 'Bold', exact: true }).click();
  const dirtyBody = await body(page).innerHTML();
  let mutations = 0;
  page.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/v1/')) mutations++;
  });
  await discardChanges(page).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(dialog).toBeVisible();
  await evidence(page, 'discard-changes');
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(title(page)).toHaveValue('Unsaved title to discard');
  expect(await body(page).innerHTML()).toBe(dirtyBody);
  await expect(save(page)).toBeEnabled();
  await confirmDiscard(page);
  await expect(title(page)).toHaveValue(baseline.data.revision.title);
  await expect(body(page)).toHaveText(baselineBody, { useInnerText: true });
  expect(await body(page).locator('h1, h2, h3, h4, h5, h6').allTextContents()).toEqual(baselineHeadings);
  await expect(save(page)).toBeDisabled();
  await expect(discardChanges(page)).toBeDisabled();
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(body(page)).toHaveText(baselineBody, { useInnerText: true });
  await expect(save(page)).toBeDisabled();
  expect(mutations).toBe(0);
  expect(await readDocument(context)).toEqual(baseline);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  await title(page).fill('Title changed after deliberate discard');
  await explicitSave(page);
  expect((await readDocument(context)).data.revision.content).toEqual(baseline.data.revision.content);
});

test('discarding a new document returns its initial local baseline without creating a document', async ({ page, context }) => {
  await login(page);
  await expect(title(page)).toHaveValue('Release checklist');
  const original = await readDocument(context);
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await expect(title(page)).toHaveValue('Untitled document');
  await title(page).fill('Never-created draft title');
  await body(page).fill('This discarded body must never reach the API.');
  let creations = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/spaces/${seeded.spaceId}/documents`) creations++;
  });
  await confirmDiscard(page);
  await expect(title(page)).toHaveValue('Untitled document');
  await expect(body(page)).toHaveText('');
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(body(page)).toHaveText('');
  expect(creations).toBe(0);
  expect(await demo.database.prisma.document.count({ where: { spaceId: seeded.spaceId } })).toBe(1);
  expect(await readDocument(context)).toEqual(original);
});

test('discard after a stale save keeps the old baseline and requires deliberate reconciliation before saving', async ({ page, context }) => {
  await login(page);
  await expect(title(page)).toHaveValue('Release checklist');
  const original = await readDocument(context);
  const second = await context.newPage();
  try {
    await second.goto(url());
    await expect(title(second)).toHaveValue(original.data.revision.title);
    const baselineBody = await body(second).innerText();
    await title(page).fill('Latest server title stays separate');
    await body(page).fill('Only the first tab saved this server body.');
    await explicitSave(page);
    const latest = await readDocument(context);
    await title(second).fill('Discard this conflicted local title');
    await body(second).fill('Discard this complete conflicted local body.');
    let attempts = 0;
    const etags: Array<string | undefined> = [];
    second.on('request', request => {
      if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/v1/documents/${seeded.documentId}`) {
        attempts++;
        etags.push(request.headers()['if-match']);
      }
    });
    const stale = second.waitForResponse(response => response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}`);
    await save(second).click();
    expect((await stale).status()).toBe(412);
    await expect(second.getByRole('heading', { name: 'Save conflict', exact: true })).toBeVisible();
    await confirmDiscard(second);
    await expect(title(second)).toHaveValue(original.data.revision.title);
    await expect(body(second)).toHaveText(baselineBody, { useInnerText: true });
    await expect(second.getByRole('heading', { name: 'Save conflict', exact: true })).toBeVisible();
    await expect(second.getByText(latest.data.revision.title, { exact: true }).last()).toBeVisible();
    await expect(save(second)).toBeDisabled();
    await body(second).focus();
    await second.keyboard.press('ControlOrMeta+z');
    await expect(body(second)).toHaveText(baselineBody, { useInnerText: true });
    await expect(save(second)).toBeDisabled();
    expect(attempts).toBe(1);
    expect(etags).toEqual([original.etag]);
    expect(await readDocument(context)).toEqual(latest);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
    await title(second).fill('Deliberately reconciled after discard');
    await expect(save(second)).toBeDisabled();
    await second.getByRole('button', { name: 'Use my changes', exact: true }).click();
    await expect(save(second)).toBeEnabled();
    expect(attempts).toBe(1);
    await explicitSave(second);
    expect(attempts).toBe(2);
    expect(etags).toEqual([original.etag, latest.etag]);
    const reconciled = await readDocument(context);
    expect(reconciled.data.currentRevisionNumber).toBe(3);
    expect(reconciled.data.revision.content).toEqual(original.data.revision.content);
    expect(reconciled.data.revision.title).toBe('Deliberately reconciled after discard');
  } finally { await second.close(); }
});
