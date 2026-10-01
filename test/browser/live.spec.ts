// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { expect, test, type Page, type BrowserContext, type WebSocketRoute } from '@playwright/test';
import { createBrowserDemo, type BrowserDemo } from './fixture.js';
import type { DemoBResult } from '../../scripts/demo-b.js';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { validateContent } from '../../src/shared/content.js';
import type { operations } from '../../web/src/api/schema.js';

let demo: BrowserDemo, seeded: DemoBResult;
test.beforeAll(async () => { demo = await createBrowserDemo({ collaboration: true }); });
test.afterAll(async () => { await demo?.close(); });
test.beforeEach(async () => { seeded = await demo.seed(); });
const title = (page: Page) => page.getByRole('textbox', { name: 'Document title', exact: true });
const body = (page: Page) => page.getByRole('textbox', { name: 'Document body', exact: true });
const save = (page: Page) => page.locator('.documentbar').getByRole('button', { name: 'Save', exact: true });
async function login(page: Page, role: 'administrator' | 'editor' | 'reader' | 'outsider' = 'editor') {
  await page.goto(`${demo.origin}/?space=${seeded.spaceId}&document=${seeded.documentId}`);
  await demo.fillCredentials(page.getByLabel('Email', { exact: true }), page.getByLabel('Password', { exact: true }), role);
  await page.getByRole('button', { name: 'Log in', exact: true }).click(); demo.authenticationCompleted();
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
}
async function enroll(page: Page) {
  await page.getByLabel('Document actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Enable shared editing', exact: true }).click();
  await expect(body(page)).toBeEditable();
  await expect(page.locator('.document-comments > summary')).toBeVisible();
  await expect(page.getByText('Connecting shared document…', { exact: true })).toHaveCount(0);
}
async function latest(context: BrowserContext) {
  const response = await context.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<operations['readDocument']['responses'][200]['content']['application/json']>;
}
async function slashBlock(page: Page, query: string, label: string) {
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Enter');
  await page.keyboard.type(`/${query}`); await page.getByRole('option', { name: new RegExp(`^${label}\\b`) }).click();
}

test('native two-tab title/body convergence, peer-safe undo, explicit checkpoint and deliberate stale reconciliation', async ({ page, context }) => {
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  const second = await context.newPage();
  try {
    await second.goto(page.url());
    await expect(second.locator('.document-comments > summary')).toBeVisible();
    await expect(body(second)).toBeEditable();
    expect((await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).sequence).toBe(0n);
    await title(page).fill('Shared 🚀 title');
    await expect(title(second)).toHaveValue('Shared 🚀 title');
    await body(page).focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Enter');
    await page.keyboard.type('Locally created paragraph ');
    await expect(body(second)).toContainText('Locally created paragraph');
    await body(second).focus(); await second.keyboard.press('ControlOrMeta+End'); await second.keyboard.type('peer contribution');
    await expect(body(page)).toContainText('peer contribution');
    await page.getByRole('button', { name: 'Undo my changes', exact: true }).click();
    await expect(body(page)).toContainText('peer contribution');
    await expect(body(second)).toContainText('peer contribution');
    await expect(save(page)).toBeEnabled(); await save(page).click();
    await expect(page.getByText('Saved revision 2.', { exact: true })).toBeVisible();
    await expect(save(page)).toBeDisabled(); expect((await latest(context)).currentRevisionNumber).toBe(2);
    await title(second).fill('Complete second-tab draft after checkpoint');
    await expect(title(page)).toHaveValue('Complete second-tab draft after checkpoint');
    await expect(save(second)).toBeEnabled(); await save(second).click();
    await expect(second.getByRole('complementary', { name: 'Save conflict' })).toBeVisible();
    await expect(title(second)).toHaveValue('Complete second-tab draft after checkpoint');
    await expect(body(second)).toContainText('peer contribution');
    expect((await latest(context)).currentRevisionNumber).toBe(2);
    await second.getByRole('button', { name: 'Use current shared content', exact: true }).click();
    await save(second).click(); await expect(second.getByText('Saved revision 3.', { exact: true })).toBeVisible();
    await expect(save(second)).toBeDisabled();
    const current = await latest(context); expect(current.currentRevisionNumber).toBe(3);
    expect(current.revision.title).toBe('Complete second-tab draft after checkpoint'); expect(current.revision.plainText).toContain('peer contribution');
    await second.reload(); await expect(title(second)).toHaveValue(current.revision.title);
    await expect(body(second)).toContainText('peer contribution');
    expect(await second.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  } finally { second.on('dialog', dialog => dialog.accept()); await second.close(); }
});

test('supplied comment composer persists private threads; readers can view but not write and outsiders remain isolated', async ({ page, browser, context }) => {
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  const composer = page.locator('.bn-comment-editor [contenteditable="true"]');
  await expect(composer).toBeVisible(); await composer.fill('Check the synthetic recovery procedure.');
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.document-comments > summary').click();
  await expect(page.locator('.document-comments')).toContainText('Check the synthetic recovery procedure.');
  expect((await latest(context)).currentRevisionNumber).toBe(1);
  await page.reload(); await expect(body(page)).toBeEditable(); await page.locator('.document-comments > summary').click();
  await expect(page.locator('.document-comments')).toContainText('Check the synthetic recovery procedure.');
  const reader = await browser.newContext(), outsider = await browser.newContext();
  try {
    const readerPage = await reader.newPage(); await login(readerPage, 'reader');
    await expect(body(readerPage)).not.toBeEditable(); await readerPage.locator('.document-comments > summary').click();
    await expect(readerPage.locator('.document-comments')).toContainText('Check the synthetic recovery procedure.');
    await readerPage.locator('.document-comments .bn-thread').focus();
    await expect(readerPage.locator('.documentbar').getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(readerPage.locator('.document-comments [contenteditable="true"]')).toHaveCount(0);
    const epoch = (await demo.database.prisma.document.findUniqueOrThrow({ where: { id: seeded.documentId } })).liveEpoch;
    const denied = await reader.request.post(`${demo.origin}/api/v1/documents/${seeded.documentId}/live/${epoch}/threads`, {
      headers: { Origin: demo.origin }, data: { initialComment: { body: [{ id: 'denied-comment', type: 'paragraph', props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' }, content: [{ type: 'text', text: 'Denied reader comment', styles: {} }], children: [] }] } },
    }); expect(denied.status()).toBe(404);
    const outsiderPage = await outsider.newPage(); await login(outsiderPage, 'outsider');
    await expect(outsiderPage.getByText('Check the synthetic recovery procedure.')).toHaveCount(0);
    await expect(body(outsiderPage)).toHaveCount(0);
    for (const path of ['/live', '/export', '/revisions']) expect((await outsider.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}${path}`)).status()).toBe(404);
  } finally { await reader.close(); await outsider.close(); }
});

test('shared restore creates a new epoch and revision; archive/unarchive and export preserve saved history', async ({ page, context }) => {
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page); await expect(title(page)).toBeVisible(); const original = await latest(context); await enroll(page);
  await title(page).fill('Shared revised recovery checklist'); await expect(save(page)).toBeEnabled(); await save(page).click();
  await expect(page.getByText('Saved revision 2.', { exact: true })).toBeVisible();
  const oldEpoch = (await demo.database.prisma.document.findUniqueOrThrow({ where: { id: seeded.documentId } })).liveEpoch;
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: /^Revision 1\b/ }).click();
  await page.getByRole('button', { name: 'Restore revision 1', exact: true }).click();
  await expect(title(page)).toHaveValue(original.revision.title);
  await expect(body(page)).toBeEditable().catch(error => { if (runtimeErrors.length) throw new Error(runtimeErrors.join('\n')); throw error; });
  expect((await latest(context)).currentRevisionNumber).toBe(3);
  expect((await demo.database.prisma.document.findUniqueOrThrow({ where: { id: seeded.documentId } })).liveEpoch).not.toBe(oldEpoch);
  await page.getByLabel('Document actions', { exact: true }).click(); await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText(/Archived/).first()).toBeVisible(); await expect(body(page)).not.toBeEditable();
  await page.getByLabel('Document actions', { exact: true }).click(); await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
  await expect(body(page)).toBeEditable(); expect((await latest(context)).currentRevisionNumber).toBe(3);
  const response = await context.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}/export`);
  expect(response.status()).toBe(200); const exported = await response.json();
  expect(exported.revision.revisionNumber).toBe(3);
  expect(JSON.stringify(exported)).not.toMatch(/"(?:threads|password|token|session|account|email|cookie)"\s*:/i);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(3);
  expect(runtimeErrors).toEqual([]);
});

test('an interrupted unsent draft is retained separately and deliberate reconnect never replays it', async ({ page, context }) => {
  let forwarding = true, wire: WebSocketRoute | undefined, connections = 0, dropped = 0;
  await context.routeWebSocket('**/api/v1/live', socket => {
    wire = socket; connections++;
    const server = socket.connectToServer();
    socket.onMessage(message => { if (forwarding) server.send(message); else dropped++; });
  });
  await login(page); await expect(title(page)).toBeVisible(); const original = await latest(context); await enroll(page);
  forwarding = false;
  await title(page).fill('Complete unsent synthetic title');
  await body(page).fill('Complete unsent synthetic body with private in-memory work.');
  await expect.poll(() => dropped).toBeGreaterThan(0);
  if (!wire) throw new Error('Expected actual routed shared connection');
  await wire.close({ code: 1011, reason: 'Synthetic connection interruption' });
  await expect(page.getByText('The shared connection closed.', { exact: true })).toBeVisible();
  await expect(title(page)).toHaveValue('Complete unsent synthetic title');
  await expect(body(page)).toContainText('Complete unsent synthetic body'); await expect(body(page)).not.toBeEditable();
  expect(connections).toBe(1); expect((await latest(context)).currentRevisionNumber).toBe(1);
  forwarding = true;
  await page.getByRole('button', { name: 'Reconnect and compare', exact: true }).click();
  await expect(body(page)).toBeEditable(); await expect(title(page)).toHaveValue(original.revision.title);
  await expect(body(page)).not.toContainText('Complete unsent synthetic body');
  const retained = page.getByRole('complementary', { name: 'Retained local draft' });
  await expect(retained).toContainText('Complete unsent synthetic title');
  const downloadPromise = page.waitForEvent('download'); await retained.getByRole('button', { name: 'Download retained local draft' }).click();
  const download = await downloadPromise, stream = await download.createReadStream(), chunks: Buffer[] = [];
  if (!stream) throw new Error('Expected complete local draft download'); for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const draft = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(draft.title).toBe('Complete unsent synthetic title'); expect(JSON.stringify(draft.content)).toContain('Complete unsent synthetic body');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  const discard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(discard).toBeVisible(); await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(retained).toContainText('Complete unsent synthetic body');
  expect(connections).toBe(2);
  expect((await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).sequence).toBe(0n);
  expect((await latest(context)).currentRevisionNumber).toBe(1);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('native rich-block and title undo/redo preserve another tab\'s heading, table and title contributions', async ({ page, context }) => {
  await login(page); await expect(title(page)).toBeVisible(); const original = await latest(context); await enroll(page);
  const second = await context.newPage();
  try {
    await second.goto(page.url()); await expect(body(second)).toBeEditable();
    await body(page).fill('Shared native integration');
    await slashBlock(page, 'h2', 'Heading 2'); await page.keyboard.insertText('Local heading');
    const peerHeading = body(second).getByRole('heading', { name: 'Local heading', exact: true });
    await peerHeading.click(); await second.keyboard.press('End'); await second.keyboard.insertText(' peer heading');
    await expect(body(page)).toContainText('peer heading');
    await slashBlock(page, 'table', 'Table');
    const peerCell = body(second).getByRole('table').getByRole('cell').first();
    await peerCell.click(); await second.keyboard.insertText('peer table'); await expect(body(page)).toContainText('peer table');
    await title(page).fill('Local title'); await expect(title(second)).toHaveValue('Local title');
    await title(second).focus(); await second.keyboard.press('End'); await second.keyboard.insertText(' peer title');
    await expect(title(page)).toHaveValue('Local title peer title');
    await title(page).focus(); await page.keyboard.press('ControlOrMeta+z');
    await expect(title(page)).toHaveValue(`${original.revision.title} peer title`); await expect(title(second)).toHaveValue(`${original.revision.title} peer title`);
    await title(page).press('ControlOrMeta+Shift+z'); await expect(title(page)).toHaveValue('Local title peer title');
    await page.getByRole('button', { name: 'Undo my changes', exact: true }).click();
    for (const tab of [page, second]) { await expect(body(tab)).toContainText('peer heading'); await expect(body(tab)).toContainText('peer table'); }
    await expect(page.getByRole('button', { name: 'Redo my changes', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Redo my changes', exact: true }).click();
    await body(page).focus(); await page.keyboard.press('ControlOrMeta+z');
    for (const tab of [page, second]) { await expect(body(tab)).toContainText('peer heading'); await expect(body(tab)).toContainText('peer table'); }
    expect((await latest(context)).currentRevisionNumber).toBe(1);
  } finally { second.on('dialog', dialog => dialog.accept()); await second.close(); }
});

test('failed checkpoints retain edits; real membership revocation closes the connection and removes server actions', async ({ page, context, browser }) => {
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  await title(page).fill('Unsaved shared title after failed checkpoint');
  await body(page).fill('The complete shared body remains available in this tab.');
  await expect(save(page)).toBeEnabled();
  const endpoint = `**/api/v1/documents/${seeded.documentId}/live/*/checkpoint`;
  await page.route(endpoint, route => route.fulfill({ status: 500, contentType: 'application/problem+json',
    body: JSON.stringify({ type: 'about:blank', title: 'Synthetic temporary failure', status: 500, detail: 'Synthetic failure before request acceptance' }),
  }));
  await save(page).click(); await expect(page.getByRole('alert').filter({ hasText: 'The request failed. Your unsaved work has not been saved.' })).toBeVisible();
  await expect(title(page)).toHaveValue('Unsaved shared title after failed checkpoint');
  await expect(body(page)).toContainText('The complete shared body'); expect((await latest(context)).currentRevisionNumber).toBe(1);
  await page.unroute(endpoint);
  const administrator = await browser.newContext();
  try {
    const adminPage = await administrator.newPage(); await login(adminPage, 'administrator');
    const space = await administrator.request.get(`${demo.origin}/api/v1/spaces/${seeded.spaceId}`); expect(space.status()).toBe(200);
    const revoked = await administrator.request.delete(`${demo.origin}/api/v1/spaces/${seeded.spaceId}/members/${demo.accountId('editor')}`, {
      headers: { Origin: demo.origin, 'If-Match': space.headers().etag! },
    }); expect(revoked.status()).toBe(200);
    await expect(page.getByText('The shared connection closed.', { exact: true })).toBeVisible();
    await expect(body(page)).not.toBeEditable();
    await page.getByRole('button', { name: 'Reconnect and compare', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Access to this document is unavailable.' })).toBeVisible();
    await expect(title(page)).toHaveValue('Unsaved shared title after failed checkpoint');
    await expect(body(page)).toContainText('The complete shared body');
    await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveCount(0);
    await expect(save(page)).toHaveCount(0); await expect(page.getByLabel('Document actions', { exact: true })).toHaveCount(0);
    expect((await context.request.get(`${demo.origin}/api/v1/me`)).status()).toBe(200);
    expect((await context.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}/live`)).status()).toBe(404);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  } finally { await administrator.close(); }
});

test('a failed native comment submission keeps its composer text, reports failure and allows a deliberate retry', async ({ page, context }) => {
  const statuses: number[] = []; page.on('response', response => { if (new URL(response.url()).pathname.includes('/threads') && response.request().method() === 'POST') statuses.push(response.status()); });
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  const composer = page.locator('.bn-comment-editor [contenteditable="true"]');
  await composer.fill('Complete retained comment draft.');
  const endpoint = `**/api/v1/documents/${seeded.documentId}/live/*/threads`;
  await page.route(endpoint, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await composer.press('ControlOrMeta+Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'The comment action did not finish.' })).toBeVisible();
  await expect(composer).toHaveText('Complete retained comment draft.'); expect((await latest(context)).currentRevisionNumber).toBe(1);
  await page.unroute(endpoint);
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.document-comments > summary').click(); await expect(page.locator('.document-comments')).toContainText('Complete retained comment draft.');
  await expect.poll(() => statuses.slice(-2)).toEqual([200, 200]);
  await expect(page.getByRole('alert').filter({ hasText: 'The comment action did not finish.' })).toHaveCount(0);
  expect(runtimeErrors).toEqual([]); expect((await latest(context)).currentRevisionNumber).toBe(1);
  await page.locator('.document-comments').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/live-comments-desktop.png', mask: [page.locator('.account span')] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.document-comments').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/live-comments-mobile.png', mask: [page.locator('.account span')] });
  const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.save-actions,.bn-thread,.bn-editor,.bn-thread-comment,.editor-content')]
    .filter(element => element.getBoundingClientRect().right > innerWidth)
    .map(element => ({ className: element.className, width: element.getBoundingClientRect().width })));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(overflow)).toBe(true);
});

test('a failed live-state read stays read-only and explicit retry recovers the authorized editing workflow', async ({ page }) => {
  const endpoint = `**/api/v1/documents/${seeded.documentId}/live`;
  await page.route(endpoint, route => route.request().method() === 'GET'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : route.continue());
  await login(page); await expect(title(page)).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Shared document state could not be checked.' })).toBeVisible();
  await expect(body(page)).not.toBeEditable(); await expect(save(page)).toHaveCount(0);
  await page.unroute(endpoint); await page.getByRole('button', { name: 'Retry shared document', exact: true }).click();
  await expect(body(page)).toBeEditable(); await enroll(page);
});

test('a successful enrollment followed by a failed head read cannot fall back to solo writes; retry uses the current checkpoint ETag', async ({ page, context }) => {
  await login(page); await expect(title(page)).toBeVisible(); await expect(body(page)).toBeEditable();
  const endpoint = `**/api/v1/documents/${seeded.documentId}`;
  await page.route(endpoint, route => route.request().method() === 'GET'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.getByLabel('Document actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Enable shared editing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry shared document', exact: true })).toBeVisible();
  await expect(body(page)).not.toBeEditable(); await expect(save(page)).toHaveCount(0);
  expect((await demo.database.prisma.document.findUniqueOrThrow({ where: { id: seeded.documentId } })).liveEpoch).not.toBeNull();
  await page.unroute(endpoint); await page.getByRole('button', { name: 'Retry shared document', exact: true }).click();
  await expect(body(page)).toBeEditable(); await expect(page.locator('.document-comments > summary')).toBeVisible();
  await title(page).fill('Checkpoint after deliberate enrollment recovery'); await expect(save(page)).toBeEnabled(); await save(page).click();
  await expect(page.getByText('Saved revision 2.', { exact: true })).toBeVisible(); expect((await latest(context)).currentRevisionNumber).toBe(2);
});

test('unsent native comment text blocks navigation and reload; in-flight submission freezes the composer and cannot be abandoned', async ({ page, context }) => {
  await login(page); await expect(title(page)).toBeVisible();
  const originalResponse = await context.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}`);
  expect(originalResponse.status()).toBe(200);
  const original = await originalResponse.json() as { revision: { title: string; content: unknown } };
  const other = await context.request.post(`${demo.origin}/api/v1/spaces/${seeded.spaceId}/documents`, {
    headers: { Origin: demo.origin }, data: { title: 'Comment navigation target', content: original.revision.content },
  }); expect(other.status()).toBe(201);
  await page.reload(); await page.getByRole('link', { name: 'Comment navigation target', exact: true }).click();
  await expect(title(page)).toHaveValue('Comment navigation target');
  await page.getByRole('link', { name: original.revision.title, exact: true }).click();
  await expect(title(page)).toHaveValue(original.revision.title); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  const composer = page.locator('.bn-comment-editor .bn-editor');
  await composer.fill('Complete unsent native comment draft.');
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved comment text.' })).toBeVisible();
  expect((await latest(context)).currentRevisionNumber).toBe(1);
  // Keep the supplied controller's own outside-click confirmation, too.
  page.on('dialog', dialog => dialog.dismiss());
  await page.evaluate(() => history.back());
  const guard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(guard).toBeVisible(); await expect(guard).toContainText('unsent comment text');
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(composer).toHaveText('Complete unsent native comment draft.');
  const unload = page.waitForEvent('dialog'); await page.reload({ timeout: 5_000 }).catch(() => {});
  expect((await unload).type()).toBe('beforeunload');
  await expect(composer).toHaveText('Complete unsent native comment draft.');
  const endpoint = `**/api/v1/documents/${seeded.documentId}/live/*/threads`;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(endpoint, async route => { await gate; await route.continue(); });
  try {
    await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Submitting comment…' })).toBeVisible();
    await expect(page.locator('.bn-comment-editor [contenteditable="true"]')).toHaveCount(0);
    await composer.press('x'); await expect(composer).toHaveText('Complete unsent native comment draft.');
    await expect(page.locator('.listhead button')).toBeDisabled();
    await page.evaluate(() => history.back());
    const waiting = page.getByRole('dialog', { name: 'Please wait', exact: true });
    await expect(waiting).toBeVisible(); await expect(waiting.getByRole('button', { name: 'Discard changes', exact: true })).toBeDisabled();
    await waiting.getByRole('button', { name: 'Keep editing', exact: true }).click();
    expect((await latest(context)).currentRevisionNumber).toBe(1);
  } finally { release?.(); }
  await page.locator('.document-comments > summary').click();
  await expect(page.locator('.document-comments')).toContainText('Complete unsent native comment draft.');
  await expect(page.getByRole('status').filter({ hasText: /Unsaved comment text\.|Submitting comment/ })).toHaveCount(0);
  expect((await latest(context)).currentRevisionNumber).toBe(1);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await expect(title(page)).toHaveValue('Untitled document'); await expect(guard).toHaveCount(0);
});

test('separate authenticated users merge concurrent native title/body edits and undo only their own contribution', async ({ page, context, browser }) => {
  const administrator = await browser.newContext();
  let hold = false;
  const queued: Array<() => void> = [];
  const routeSocket = (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    server.onMessage(message => { if (hold) queued.push(() => socket.send(message)); else socket.send(message); });
  };
  await context.routeWebSocket('**/api/v1/live', routeSocket);
  await administrator.routeWebSocket('**/api/v1/live', routeSocket);
  try {
    await login(page); await expect(title(page)).toBeVisible(); const original = await latest(context); await enroll(page);
    const peer = await administrator.newPage(); await login(peer, 'administrator'); await expect(body(peer)).toBeEditable();
    await body(page).focus(); await page.keyboard.press('ControlOrMeta+End');
    await expect(peer.locator('.document-comments > summary')).toBeVisible();
    hold = true;
    await Promise.all([
      title(page).press('End').then(() => title(page).pressSequentially(' editor 🚀')),
      title(peer).press('End').then(() => title(peer).pressSequentially(' administrator 🌱')),
    ]);
    await Promise.all([
      body(page).press('ControlOrMeta+End').then(() => body(page).pressSequentially(' editor body')),
      body(peer).press('ControlOrMeta+End').then(() => body(peer).pressSequentially(' administrator body')),
    ]);
    await expect.poll(() => queued.length).toBeGreaterThan(0);
    hold = false; for (const send of queued.splice(0)) send();
    for (const tab of [page, peer]) {
      await expect(title(tab)).toHaveValue(new RegExp(`${original.revision.title}.*editor.*administrator|${original.revision.title}.*administrator.*editor`));
      await expect(body(tab)).toContainText('editor body'); await expect(body(tab)).toContainText('administrator body');
    }
    await expect.poll(async () => title(page).inputValue()).toBe(await title(peer).inputValue());
    // The native manager may group title and body as separate editing steps.
    // Each step must preserve the other account's contribution.
    let undone = 0;
    while ((await title(page).inputValue()).includes('editor 🚀') && undone < 3) {
      await page.getByRole('button', { name: 'Undo my changes', exact: true }).click(); undone++;
      for (const tab of [page, peer]) {
        await expect(title(tab)).toHaveValue(/administrator 🌱/);
        await expect(body(tab)).toContainText('administrator body');
      }
    }
    for (const tab of [page, peer]) await expect(title(tab)).toHaveValue(`${original.revision.title} administrator 🌱`);
    expect((await latest(context)).currentRevisionNumber).toBe(1);
    for (let step = 0; step < undone; step++) await page.getByRole('button', { name: 'Redo my changes', exact: true }).click();
    await expect(title(page)).toHaveValue(/editor 🚀/); await expect(title(peer)).toHaveValue(/editor 🚀/);
    await expect(body(page)).toContainText('administrator body'); await expect(body(peer)).toContainText('administrator body');
  } finally { hold = false; for (const send of queued.splice(0)) send(); await administrator.close(); }
});

test('restart preserves live content and comments; a disabled runtime shows only the saved revision and never offers solo writes', async ({ page, context }) => {
  await login(page); await expect(title(page)).toBeVisible(); const original = await latest(context); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.bn-comment-editor [contenteditable="true"]').fill('Durable private comment across process restart.');
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.document-comments > summary').click();
  await expect(page.locator('.document-comments')).toContainText('Durable private comment across process restart.');
  await title(page).fill('Durable live title, not yet checkpointed');
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(' Live-only durable body.');
  await expect(save(page)).toBeEnabled();
  const before = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
  expect((await latest(context)).currentRevisionNumber).toBe(1);
  let enabled = false;
  try {
    await demo.restart(false);
    await expect(page.getByText('The shared connection closed.', { exact: true })).toBeVisible();
    await expect(title(page)).toHaveValue('Durable live title, not yet checkpointed');
    await expect(body(page)).toContainText('Live-only durable body.'); await expect(body(page)).not.toBeEditable();
    const disabled = await context.newPage();
    try {
      await disabled.goto(page.url());
      await expect(disabled.getByRole('status').filter({ hasText: 'Shared editing is disabled.' })).toBeVisible();
      await expect(title(disabled)).toHaveValue(original.revision.title); await expect(title(disabled)).not.toBeEditable();
      await expect(body(disabled)).not.toContainText('Live-only durable body.'); await expect(body(disabled)).not.toBeEditable();
      await expect(save(disabled)).toHaveCount(0); await expect(disabled.locator('.document-comments')).toHaveCount(0);
      await expect(disabled.getByText('Durable private comment across process restart.')).toHaveCount(0);
      await disabled.getByRole('button', { name: 'History', exact: true }).click();
      await disabled.getByRole('button', { name: /^Revision 1\b/ }).click();
      await expect(disabled.getByRole('button', { name: /Restore revision/ })).toHaveCount(0);
      const response = await context.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}`);
      expect(response.status()).toBe(200); expect((await response.json()).editingMode).toBe('live');
      const rejected = await context.request.patch(`${demo.origin}/api/v1/documents/${seeded.documentId}`, {
        headers: { Origin: demo.origin, 'If-Match': response.headers().etag! }, data: { title: 'Denied solo write' },
      }); expect(rejected.status()).toBe(409);
      expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(before);
      expect((await latest(context)).currentRevisionNumber).toBe(1);
      await demo.restart(true); enabled = true;
      const recovered = await context.newPage();
      try {
        await recovered.goto(disabled.url()); await expect(body(recovered)).toBeEditable();
        await expect(title(recovered)).toHaveValue('Durable live title, not yet checkpointed');
        await expect(body(recovered)).toContainText('Live-only durable body.');
        await recovered.locator('.document-comments > summary').click();
        await expect(recovered.locator('.document-comments')).toContainText('Durable private comment across process restart.');
        await expect(save(recovered)).toBeEnabled(); await save(recovered).click();
        await expect(recovered.getByText('Saved revision 2.', { exact: true })).toBeVisible();
        const checkpoint = await latest(context); expect(checkpoint.currentRevisionNumber).toBe(2);
        expect(checkpoint.revision.title).toBe('Durable live title, not yet checkpointed');
        expect(checkpoint.revision.plainText).toContain('Live-only durable body.');
        expect(checkpoint.revision.plainText).not.toContain('Durable private comment');
        expect(await recovered.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
      } finally { await recovered.close(); }
    } finally { await disabled.close(); }
  } finally { if (!enabled) await demo.restart(true); }
});

test('failed native comment deletion reports failure without changing the thread or revision; deliberate retry deletes it', async ({ page, context }) => {
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.bn-comment-editor [contenteditable="true"]').fill('Synthetic native comment retained after failed deletion.');
  const anchored = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/addToDocument'));
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
  expect((await anchored).status()).toBe(200);
  const sidebar = page.locator('.document-comments'); await sidebar.locator('summary').click();
  await expect(sidebar).toContainText('Synthetic native comment retained after failed deletion.');
  // Thread creation and anchoring are separate committed operations. Capture
  // the failure baseline only after the complete native creation has finished.
  await expect(page.getByRole('status').filter({ hasText: 'Submitting comment…' })).toHaveCount(0);
  const before = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
  const endpoint = `**/api/v1/documents/${seeded.documentId}/live/*/threads/*/comments/*?soft=false`;
  await page.route(endpoint, route => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : route.continue());
  async function remove() {
    await sidebar.locator('.bn-thread-comment').first().hover();
    await sidebar.getByRole('button', { name: 'More actions', exact: true }).first().click({ timeout: 10_000 });
    await page.getByRole('menuitem', { name: 'Delete comment', exact: true }).click();
  }
  await remove();
  await expect(page.getByRole('alert').filter({ hasText: 'The comment action did not finish.' })).toBeVisible();
  await expect(sidebar).toContainText('Synthetic native comment retained after failed deletion.');
  expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(before);
  expect((await latest(context)).currentRevisionNumber).toBe(1); expect(runtimeErrors).toEqual([]);
  await page.unroute(endpoint); await remove();
  await expect(sidebar).not.toContainText('Synthetic native comment retained after failed deletion.');
  await expect(page.getByRole('alert').filter({ hasText: 'The comment action did not finish.' })).toHaveCount(0);
  expect((await latest(context)).currentRevisionNumber).toBe(1); expect(runtimeErrors).toEqual([]);
});

test('native comment actions are discoverable by keyboard and failed resolution preserves the thread until deliberate retry', async ({ page, context }) => {
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.bn-comment-editor [contenteditable="true"]').fill('Synthetic native thread awaiting resolution.');
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
  const sidebar = page.locator('.document-comments'); await sidebar.locator('summary').click();
  await expect(sidebar).toContainText('Synthetic native thread awaiting resolution.');
  await page.mouse.move(1, 1); await sidebar.locator('.bn-thread').first().focus();
  const resolve = page.getByRole('button', { name: 'Resolve', exact: true }).first();
  await expect(resolve).toBeVisible();
  const before = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
  const endpoint = `**/api/v1/documents/${seeded.documentId}/live/*/threads/*/resolve`;
  await page.route(endpoint, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await resolve.focus(); await expect(resolve).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'The comment action did not finish.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-open', exact: true })).toHaveCount(0);
  expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(before);
  expect((await latest(context)).currentRevisionNumber).toBe(1); expect(runtimeErrors).toEqual([]);
  await page.unroute(endpoint); await resolve.focus(); await page.keyboard.press('Enter');
  const reopen = page.getByRole('button', { name: 'Re-open', exact: true }).first();
  await expect(reopen).toBeVisible(); await reopen.focus(); await page.keyboard.press('Enter');
  await expect(resolve).toBeVisible(); expect((await latest(context)).currentRevisionNumber).toBe(1);
  expect(runtimeErrors).toEqual([]); expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('native reply and own-comment editing retain complete text after failures and persist only on deliberate submission', async ({ page, context }) => {
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.bn-comment-editor [contenteditable="true"]').fill('Synthetic parent thread for native replies.');
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
  const sidebar = page.locator('.document-comments'); await sidebar.locator('summary').click();
  await expect(sidebar).toContainText('Synthetic parent thread for native replies.');
  await expect(page.getByRole('status').filter({ hasText: 'Submitting comment…' })).toHaveCount(0);
  await page.mouse.move(1, 1); await sidebar.locator('.bn-thread').first().focus();
  const card = sidebar.locator('.bn-thread').first();
  const composer = card.locator('.bn-thread-composer [contenteditable="true"]');
  await composer.fill('Complete retained native reply.', { timeout: 10_000 });
  await title(page).focus(); await expect(composer).toHaveText('Complete retained native reply.');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  const guard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(guard).toBeVisible(); await expect(guard).toContainText('unsent comment text');
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(composer).toHaveText('Complete retained native reply.');
  const replyEndpoint = `**/api/v1/documents/${seeded.documentId}/live/*/threads/*/comments`;
  await page.route(replyEndpoint, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await composer.press('ControlOrMeta+Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'The comment action did not finish.' })).toBeVisible();
  await expect(composer).toHaveText('Complete retained native reply.');
  await expect(card.locator('.bn-thread-comment')).toHaveCount(1); expect((await latest(context)).currentRevisionNumber).toBe(1);
  await page.unroute(replyEndpoint); await card.locator('.bn-thread-composer').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.locator('.bn-thread-comment')).toHaveCount(2); await expect(composer).toHaveText('');
  const reply = card.locator('.bn-thread-comment').filter({ hasText: 'Complete retained native reply.' });
  await reply.getByRole('button', { name: 'More actions', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Edit comment', exact: true }).click();
  const edit = card.locator('.bn-thread-comment .bn-comment-editor [contenteditable="true"]');
  await edit.fill('Complete retained native reply after an explicit edit.');
  const beforeEdit = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
  const editEndpoint = `**/api/v1/documents/${seeded.documentId}/live/*/threads/*/comments/*`;
  await page.route(editEndpoint, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : route.continue());
  await edit.press('ControlOrMeta+Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'The comment action did not finish.' })).toBeVisible();
  await expect(edit).toHaveText('Complete retained native reply after an explicit edit.');
  expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(beforeEdit);
  expect((await latest(context)).currentRevisionNumber).toBe(1);
  await page.unroute(editEndpoint); await edit.press('ControlOrMeta+Enter');
  await expect(card.locator('.bn-thread-comment [contenteditable="true"]')).toHaveCount(0);
  await expect(card.locator('.bn-thread-comments')).toContainText('Complete retained native reply after an explicit edit.');
  await page.reload(); await expect(body(page)).toBeEditable(); await sidebar.locator('summary').click();
  await expect(sidebar.locator('.bn-thread-comment')).toHaveCount(2);
  await expect(sidebar).toContainText('Complete retained native reply after an explicit edit.');
  expect((await latest(context)).currentRevisionNumber).toBe(1); expect(runtimeErrors).toEqual([]);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('a comment-only draft survives real session expiry and deliberate same-account sign-in without saving or exposing server actions', async ({ page, context }) => {
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page); await expect(title(page)).toBeVisible(); const original = await latest(context); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.bn-comment-editor [contenteditable="true"]').fill('Saved parent for a private session-loss reply.');
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
  const sidebar = page.locator('.document-comments'); await sidebar.locator('summary').click();
  await expect(sidebar).toContainText('Saved parent for a private session-loss reply.');
  await expect(page.getByRole('status').filter({ hasText: 'Submitting comment…' })).toHaveCount(0);
  await sidebar.locator('.bn-thread').first().focus();
  const composer = sidebar.locator('.bn-thread-composer .bn-comment-editor .bn-editor');
  await composer.fill('Complete unsent reply retained through session loss.');
  await expect(save(page)).toBeDisabled();
  await expect(title(page)).toHaveValue(original.revision.title);
  const stored = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
  await demo.database.prisma.session.updateMany({ where: { userId: demo.accountId('editor') }, data: { expiresAt: new Date(0) } });
  const expired = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/revisions`);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  expect((await expired).status()).toBe(401);
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await expect(composer).toHaveText('Complete unsent reply retained through session loss.');
  await expect(sidebar.locator('[contenteditable="true"]')).toHaveCount(0);
  await composer.press('x'); await expect(composer).toHaveText('Complete unsent reply retained through session loss.');
  await expect(sidebar.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Submission is unavailable.' })).toBeVisible();
  await expect(save(page)).toHaveCount(0);
  await expect(page.getByLabel('Document actions', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveCount(0);
  await demo.fillCredentials(page.getByLabel('Email', { exact: true }), page.getByLabel('Password', { exact: true }), 'editor');
  await page.getByRole('button', { name: 'Log in', exact: true }).click(); demo.authenticationCompleted();
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  await expect(composer).toHaveText('Complete unsent reply retained through session loss.');
  await expect(page.getByText('The shared connection closed.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect and compare', exact: true }).click();
  const guard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(guard).toContainText('unsent comment text');
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(composer).toHaveText('Complete unsent reply retained through session loss.');
  expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(stored);
  expect((await latest(context)).currentRevisionNumber).toBe(1); expect(runtimeErrors).toEqual([]);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('an unsent native reply stays read-only through a real role downgrade and remains retained after membership revocation', async ({ page, context, browser }) => {
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.bn-comment-editor [contenteditable="true"]').fill('Saved thread for synthetic permission changes.');
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
  const sidebar = page.locator('.document-comments'); await sidebar.locator('summary').click();
  await expect(sidebar).toContainText('Saved thread for synthetic permission changes.');
  await expect(page.getByRole('status').filter({ hasText: 'Submitting comment…' })).toHaveCount(0);
  await sidebar.locator('.bn-thread').first().focus();
  const composer = sidebar.locator('.bn-thread-composer .bn-comment-editor .bn-editor');
  await composer.fill('Complete unsent reply retained through revoked authority.');
  const stored = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
  const administrator = await browser.newContext();
  try {
    const adminPage = await administrator.newPage(); await login(adminPage, 'administrator');
    const membership = `${demo.origin}/api/v1/spaces/${seeded.spaceId}/members/${demo.accountId('editor')}`;
    async function grant(role: 'reader' | 'editor') {
      const space = await administrator.request.get(`${demo.origin}/api/v1/spaces/${seeded.spaceId}`); expect(space.status()).toBe(200);
      expect((await administrator.request.put(membership, { headers: { Origin: demo.origin, 'If-Match': space.headers().etag! }, data: { role } })).status()).toBe(200);
    }
    await grant('reader');
    await expect(save(page)).toHaveCount(0); await expect(body(page)).not.toBeEditable();
    await expect(sidebar.locator('[contenteditable="true"]')).toHaveCount(0);
    await composer.press('x'); await expect(composer).toHaveText('Complete unsent reply retained through revoked authority.');
    await expect(sidebar.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: 'Submission is unavailable.' })).toBeVisible();
    const epoch = (await demo.database.prisma.document.findUniqueOrThrow({ where: { id: seeded.documentId } })).liveEpoch;
    expect((await context.request.post(`${demo.origin}/api/v1/documents/${seeded.documentId}/live/${epoch}/threads`, {
      headers: { Origin: demo.origin }, data: { initialComment: { body: [{ id: 'denied-reply', type: 'paragraph', props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' }, content: [{ type: 'text', text: 'Denied reader comment', styles: {} }], children: [] }] } },
    })).status()).toBe(404);
    await grant('editor');
    await expect(composer).toHaveAttribute('contenteditable', 'true');
    await expect(composer).toHaveText('Complete unsent reply retained through revoked authority.');
    await expect(sidebar.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    const space = await administrator.request.get(`${demo.origin}/api/v1/spaces/${seeded.spaceId}`); expect(space.status()).toBe(200);
    expect((await administrator.request.delete(membership, { headers: { Origin: demo.origin, 'If-Match': space.headers().etag! } })).status()).toBe(200);
    await expect(page.getByText('The shared connection closed.', { exact: true })).toBeVisible();
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/revisions`);
    await page.getByRole('button', { name: 'History', exact: true }).click(); expect((await denied).status()).toBe(404);
    await expect(composer).toHaveText('Complete unsent reply retained through revoked authority.');
    await expect(page.getByRole('alert').filter({ hasText: 'Access to this document is unavailable.' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Document actions', { exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(stored);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
    expect(runtimeErrors).toEqual([]); expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  } finally { await administrator.close(); }
});

test('live-only title, body and comments stay out of native/PDF/DOCX snapshots, saved search and selected public history', async ({ page, context, browser }) => {
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page); await expect(title(page)).toBeVisible();
  await title(page).fill('Checkpointed native export snapshot');
  await body(page).fill('Saved body available in current exports.');
  await save(page).click(); await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 2' })).toBeVisible();
  const saved = await latest(context); expect(saved.currentRevisionNumber).toBe(2); await enroll(page);
  const administrator = await browser.newContext(), anonymous = await browser.newContext();
  try {
    const adminPage = await administrator.newPage(); await login(adminPage, 'administrator');
    await expect(body(adminPage)).toBeEditable(); await adminPage.getByRole('button', { name: 'History', exact: true }).click();
    const history = adminPage.getByRole('complementary', { name: 'Revision history', exact: true });
    await history.getByRole('button', { name: /^Revision 1\b/ }).click();
    await history.getByRole('button', { name: 'Publish revision 1', exact: true }).click();
    const published = adminPage.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/publication`);
    await adminPage.getByRole('dialog', { name: 'Publish revision 1?', exact: true }).getByRole('button', { name: 'Publish revision 1', exact: true }).click();
    expect((await published).status()).toBe(200);
    const link = adminPage.getByRole('link', { name: 'View public document', exact: true }); await expect(link).toBeVisible();
    const path = await link.getAttribute('href'); if (!path) throw new Error('No selected-revision publication link');
    await page.bringToFront();
    await title(page).fill('LiveOnlyExportBoundary title');
    await body(page).fill('LiveOnlyExportBoundary body, not checkpointed.');
    await expect(body(adminPage)).toContainText('LiveOnlyExportBoundary body');
    await body(page).getByText('LiveOnlyExportBoundary body, not checkpointed.', { exact: true }).click({ clickCount: 3 });
    await page.getByRole('button', { name: 'Add comment', exact: true }).click();
    await page.locator('.bn-comment-editor [contenteditable="true"]').fill('LiveOnlyExportBoundary private comment.');
    const anchored = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/addToDocument'));
    await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click(); expect((await anchored).status()).toBe(200);
    const native = await context.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}/export`);
    expect(native.status()).toBe(200);
    const exported = await native.json() as operations['exportNativeDocument']['responses'][200]['content']['application/json'];
    expect(exported.revision.revisionNumber).toBe(2); expect(exported.revision.title).toBe(saved.revision.title);
    expect(validateContent(exported.content).content).toEqual(saved.revision.content);
    expect(JSON.stringify(exported)).not.toContain('LiveOnlyExportBoundary');
    expect(JSON.stringify(exported)).not.toMatch(/"(?:threads|password|token|session|account|email|cookie)"\s*:/i);
    async function downloadText(format: 'pdf' | 'docx', selected = false) {
      const download = page.waitForEvent('download');
      if (selected) {
        const revisions = page.getByRole('complementary', { name: 'Revision history', exact: true });
        await revisions.getByRole('button', { name: `Export ${format.toUpperCase()}`, exact: true }).click();
      } else {
        await page.getByLabel('Document actions', { exact: true }).click();
        await page.getByRole('button', { name: `Export ${format.toUpperCase()}`, exact: true }).click();
      }
      const file = await (await download).path(); if (!file) throw new Error('No rendered snapshot download');
      const bytes = await readFile(file);
      if (format === 'docx') {
        const document = (await JSZip.loadAsync(bytes)).file('word/document.xml');
        if (!document) throw new Error('DOCX has no document body'); return document.async('text');
      }
      const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
      try {
        const document = await loading.promise; const pages: string[] = [];
        for (let number = 1; number <= document.numPages; number++) {
          const content = await (await document.getPage(number)).getTextContent();
          pages.push(content.items.map(item => 'str' in item ? item.str : '').join(' '));
        }
        // PDF text items split wrapped lines and can each retain a space.
        return pages.join('\n').replace(/\s+/g, ' ').trim();
      } finally { await loading.destroy(); }
    }
    for (const format of ['pdf', 'docx'] as const) {
      const text = await downloadText(format); expect(text).toContain(saved.revision.title);
      expect(text).toContain('Saved body available in current exports.'); expect(text).not.toContain('LiveOnlyExportBoundary');
    }
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: /^Revision 1\b/ }).click();
    for (const format of ['pdf', 'docx'] as const) {
      const text = await downloadText(format, true); expect(text).toContain('Run tests before deploying.');
      expect(text).not.toContain(saved.revision.title); expect(text).not.toContain('LiveOnlyExportBoundary');
    }
    const publicPage = await anonymous.newPage(); const privateRequests: string[] = [];
    publicPage.on('request', request => { if (/\/api\/(?:v1|auth)\//.test(new URL(request.url()).pathname)) privateRequests.push('private API'); });
    await publicPage.goto(demo.origin + path);
    await expect(publicPage.getByRole('heading', { name: 'Release checklist', exact: true })).toBeVisible();
    await expect(publicPage.getByRole('textbox', { name: 'Published document content', exact: true })).toContainText('Run tests before deploying.');
    await expect(publicPage.locator('body')).not.toContainText('LiveOnlyExportBoundary');
    await expect(publicPage.locator('body')).not.toContainText(saved.revision.title); expect(privateRequests).toEqual([]);
    await title(page).focus(); await page.keyboard.press('ControlOrMeta+k');
    const search = page.getByRole('dialog', { name: 'Search documents', exact: true });
    await search.getByRole('combobox', { name: 'Search accessible documents', exact: true }).fill('LiveOnlyExportBoundary');
    await expect(search.getByRole('heading', { name: 'No matching documents', exact: true })).toBeVisible();
    await expect(search.getByRole('option')).toHaveCount(0); await search.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(title(page)).toHaveValue('LiveOnlyExportBoundary title');
    await expect(body(page)).toContainText('LiveOnlyExportBoundary body');
    expect((await latest(context)).currentRevisionNumber).toBe(2);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
    expect(runtimeErrors).toEqual([]); expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  } finally { await administrator.close(); await anonymous.close(); }
});

test('nested native list undo/redo preserves another account\'s child and checkpoints the complete hierarchy', async ({ page, context, browser }) => {
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  const administrator = await browser.newContext();
  try {
    const peer = await administrator.newPage(); await login(peer, 'administrator'); await expect(body(peer)).toBeEditable();
    await body(page).fill('Native nested list checkpoint');
    await slashBlock(page, 'bullet', 'Bullet List'); await page.keyboard.insertText('Local parent');
    await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); await page.keyboard.insertText('Local child');
    const peerChild = body(peer).getByText('Local child', { exact: true });
    await expect(peerChild).toBeVisible(); await peerChild.click(); await peer.keyboard.press('End'); await peer.keyboard.insertText(' with administrator contribution');
    for (const tab of [page, peer]) await expect(body(tab)).toContainText('Local child with administrator contribution');
    await page.getByRole('button', { name: 'Undo my changes', exact: true }).click();
    for (const tab of [page, peer]) {
      await expect(body(tab)).toContainText('administrator contribution');
      await expect(tab.getByText('Connection closed · local work retained', { exact: true })).toHaveCount(0);
    }
    expect((await latest(context)).currentRevisionNumber).toBe(1);
    await expect(page.getByRole('button', { name: 'Redo my changes', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Redo my changes', exact: true }).click();
    for (const tab of [page, peer]) {
      await expect(body(tab)).toContainText('Local parent');
      await expect(body(tab)).toContainText('Local child with administrator contribution');
    }
    await body(page).focus(); await page.keyboard.press('ControlOrMeta+z');
    for (const tab of [page, peer]) await expect(body(tab)).toContainText('administrator contribution');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(body(peer)).toContainText('Local child with administrator contribution');
    await expect(save(page)).toBeEnabled(); await save(page).click();
    await expect(page.getByText('Saved revision 2.', { exact: true })).toBeVisible();
    const saved = await latest(context); const parsed = validateContent(saved.revision.content);
    expect(saved.currentRevisionNumber).toBe(2);
    const parent = parsed.content.document.find(block => block.type === 'bulletListItem' && JSON.stringify(block.content).includes('Local parent'));
    expect(parent).toBeDefined(); expect(parent!.children).toHaveLength(1);
    expect(parent!.children[0]!.type).toBe('bulletListItem');
    expect(JSON.stringify(parent!.children[0]!.content)).toContain('Local child with administrator contribution');
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
    await page.reload(); await expect(body(page)).toContainText('Local child with administrator contribution');
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  } finally { await administrator.close(); }
});

test('native reaction failures stay visible, preserve accepted threads and require deliberate retry', async ({ page, context }) => {
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page); await expect(title(page)).toBeVisible();
  const original = await latest(context);
  const target = await context.request.post(`${demo.origin}/api/v1/spaces/${seeded.spaceId}/documents`, {
    headers: { Origin: demo.origin }, data: { title: 'Reaction navigation target', content: original.revision.content },
  }); expect(target.status()).toBe(201);
  await page.reload(); await page.getByRole('link', { name: 'Reaction navigation target', exact: true }).click();
  await expect(title(page)).toHaveValue('Reaction navigation target');
  await page.getByRole('link', { name: original.revision.title, exact: true }).click();
  await expect(title(page)).toHaveValue(original.revision.title); await enroll(page);
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.bn-comment-editor [contenteditable="true"]').fill('Synthetic thread for native reaction recovery.');
  const anchored = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/addToDocument'));
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click(); expect((await anchored).status()).toBe(200);
  const sidebar = page.locator('.document-comments'); await sidebar.locator('summary').click();
  await expect(sidebar).toContainText('Synthetic thread for native reaction recovery.');
  await expect(page.getByRole('status').filter({ hasText: 'Submitting comment…' })).toHaveCount(0);
  const before = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
  const endpoint = `**/api/v1/documents/${seeded.documentId}/live/*/threads/*/comments/*/reactions`;
  await page.route(endpoint, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  async function react() {
    await sidebar.getByRole('button', { name: 'Add reaction', exact: true }).first().click();
    await page.locator('em-emoji-picker').getByRole('button', { name: '😀', exact: true }).first().click();
  }
  await react();
  const error = page.getByRole('alert').filter({ hasText: 'The comment action did not finish.' });
  await expect(error).toBeVisible(); await expect(sidebar.locator('.bn-comment-reaction')).toHaveCount(0);
  expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(before);
  expect((await latest(context)).currentRevisionNumber).toBe(1); expect(runtimeErrors).toEqual([]);
  await page.unroute(endpoint);
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(endpoint, async route => { await gate; await route.continue(); });
  const added = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/reactions'));
  try {
    await react(); await expect(page.getByRole('status').filter({ hasText: 'Submitting comment…' })).toBeVisible();
    await expect(sidebar.locator('summary')).toHaveAttribute('aria-disabled', 'true');
    await page.evaluate(() => history.back());
    const waiting = page.getByRole('dialog', { name: 'Please wait', exact: true });
    await expect(waiting).toBeVisible(); await expect(waiting.getByRole('button', { name: 'Discard changes', exact: true })).toBeDisabled();
    await waiting.getByRole('button', { name: 'Keep editing', exact: true }).click();
    expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(before);
  } finally { release?.(); }
  expect((await added).status()).toBe(200); await page.unroute(endpoint);
  const reaction = sidebar.locator('.bn-comment-reaction'); await expect(reaction).toHaveCount(1); await expect(reaction).toContainText('1');
  await expect(error).toHaveCount(0);
  const accepted = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
  const removal = `${endpoint}/*`;
  await page.route(removal, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await reaction.press('Enter'); await expect(error).toBeVisible(); await expect(reaction).toContainText('1');
  expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(accepted);
  await page.unroute(removal); await reaction.press('Enter'); await expect(reaction).toHaveCount(0); await expect(error).toHaveCount(0);
  expect((await latest(context)).currentRevisionNumber).toBe(1); expect(runtimeErrors).toEqual([]);
  // The supplied picker stores only recent emoji IDs/counts, never documents,
  // comments, identities or credentials. Assert its complete persisted shape.
  expect(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])))).toEqual({
    'emoji-mart.last': JSON.stringify('grinning'),
    'emoji-mart.frequently': JSON.stringify({ '+1': 9, grinning: 10, kissing_heart: 7, heart_eyes: 6, laughing: 5,
      stuck_out_tongue_winking_eye: 4, sweat_smile: 3, joy: 2, scream: 1 }),
  });
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test('abrupt process death preserves acknowledged native content and comments across separate authenticated sessions', async ({ page, context, browser }) => {
  await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
  const administrator = await browser.newContext();
  try {
    const peer = await administrator.newPage(); await login(peer, 'administrator'); await expect(body(peer)).toBeEditable();
    await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
    await page.getByRole('button', { name: 'Add comment', exact: true }).click();
    await page.locator('.bn-comment-editor [contenteditable="true"]').fill('Acknowledged private comment survives abrupt process death.');
    const anchored = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/addToDocument'));
    await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click(); expect((await anchored).status()).toBe(200);
    await title(page).fill('Acknowledged live title across abrupt process death');
    await body(page).focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' Acknowledged native crash recovery body.');
    await expect(save(page)).toBeEnabled();
    await expect(title(peer)).toHaveValue('Acknowledged live title across abrupt process death');
    await expect(body(peer)).toContainText('Acknowledged native crash recovery body.');
    const before = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
    expect((await latest(context)).currentRevisionNumber).toBe(1);
    await demo.crashAndRestart();
    for (const tab of [page, peer]) {
      await expect(tab.getByText('The shared connection closed.', { exact: true })).toBeVisible();
      await expect(title(tab)).toHaveValue('Acknowledged live title across abrupt process death');
      await expect(body(tab)).toContainText('Acknowledged native crash recovery body.');
      await expect(body(tab)).not.toBeEditable();
    }
    const recovered = await context.newPage(), recoveredPeer = await administrator.newPage();
    try {
      for (const tab of [recovered, recoveredPeer]) {
        await tab.goto(page.url()); await expect(body(tab)).toBeEditable();
        await expect(title(tab)).toHaveValue('Acknowledged live title across abrupt process death');
        await expect(body(tab)).toContainText('Acknowledged native crash recovery body.');
        await tab.locator('.document-comments > summary').click();
        await expect(tab.locator('.document-comments')).toContainText('Acknowledged private comment survives abrupt process death.');
      }
      expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(before);
      expect((await latest(context)).currentRevisionNumber).toBe(1);
      await expect(save(recovered)).toBeEnabled(); await save(recovered).click();
      await expect(recovered.getByText('Saved revision 2.', { exact: true })).toBeVisible();
      const saved = await latest(context); expect(saved.currentRevisionNumber).toBe(2);
      expect(saved.revision.title).toBe('Acknowledged live title across abrupt process death');
      expect(saved.revision.plainText).toContain('Acknowledged native crash recovery body.');
      expect(saved.revision.plainText).not.toContain('Acknowledged private comment'); validateContent(saved.revision.content);
      expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
      for (const tab of [recovered, recoveredPeer]) expect(await tab.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    } finally { await recovered.close(); await recoveredPeer.close(); }
  } finally { await administrator.close(); }
});

test('operator account recovery revokes every live session while preserving an unsent native reply and other accounts', async ({ page, context, browser }) => {
  const secondary = await browser.newContext(), administrator = await browser.newContext();
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  try {
    await login(page); await expect(title(page)).toBeVisible(); await enroll(page);
    const otherSession = await secondary.newPage(); await login(otherSession); await expect(body(otherSession)).toBeEditable();
    const peer = await administrator.newPage(); await login(peer, 'administrator'); await expect(body(peer)).toBeEditable();
    await body(page).focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
    await page.getByRole('button', { name: 'Add comment', exact: true }).click();
    await page.locator('.bn-comment-editor [contenteditable="true"]').fill('Saved thread before operator account recovery.');
    const anchored = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/addToDocument'));
    await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click(); expect((await anchored).status()).toBe(200);
    const sidebar = page.locator('.document-comments'); await sidebar.locator('summary').click();
    const card = sidebar.locator('.bn-thread'); await card.focus();
    const composer = card.locator('.bn-thread-composer .bn-comment-editor .bn-editor');
    await composer.fill('Complete unsent reply retained across operator recovery.');
    await expect(page.getByRole('status').filter({ hasText: 'Unsaved comment text.' })).toBeVisible();
    const before = await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } });
    expect(await demo.database.prisma.session.count({ where: { userId: demo.accountId('editor') } })).toBeGreaterThanOrEqual(2);
    await demo.recoverAccount('editor');
    expect(await demo.database.prisma.session.count({ where: { userId: demo.accountId('editor') } })).toBe(0);
    for (const tab of [page, otherSession]) await expect(tab.getByText('The shared connection closed.', { exact: true })).toBeVisible();
    await expect(body(peer)).toBeEditable();
    for (const expired of [context, secondary]) {
      const denied = await expired.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}`); expect(denied.status()).toBe(401);
      expect((await denied.text())).not.toContain('Release checklist');
    }
    const lost = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/revisions'));
    await page.getByRole('button', { name: 'History', exact: true }).click(); expect((await lost).status()).toBe(401);
    await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
    await expect(composer).toHaveText('Complete unsent reply retained across operator recovery.');
    await expect(sidebar.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveCount(0);
    expect(await demo.database.prisma.documentLive.findFirstOrThrow({ where: { documentId: seeded.documentId } })).toEqual(before);
    await title(peer).fill('Other account remains authorized after recovery'); await expect(save(peer)).toBeEnabled();
    await expect(title(otherSession)).not.toHaveValue('Other account remains authorized after recovery');
    await demo.fillCredentials(page.getByLabel('Email', { exact: true }), page.getByLabel('Password', { exact: true }), 'editor');
    await page.getByRole('button', { name: 'Log in', exact: true }).click(); demo.authenticationCompleted();
    await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
    await expect(composer).toHaveText('Complete unsent reply retained across operator recovery.');
    await page.getByRole('button', { name: 'Reconnect and compare', exact: true }).click();
    const guard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true }); await expect(guard).toContainText('unsent comment text');
    await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(composer).toHaveText('Complete unsent reply retained across operator recovery.');
    expect((await latest(administrator)).currentRevisionNumber).toBe(1); expect(runtimeErrors).toEqual([]);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  } finally { await secondary.close(); await administrator.close(); }
});
