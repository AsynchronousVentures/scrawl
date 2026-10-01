// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { expect, test, type Page, type BrowserContext, type WebSocketRoute } from '@playwright/test';
import { createBrowserDemo, type BrowserDemo } from './fixture.js';
import type { DemoBResult } from '../../scripts/demo-b.js';

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
  return response.json() as Promise<{ currentRevisionNumber: number; revision: { title: string; plainText: string } }>;
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
  await page.locator('.bn-thread').getByRole('button', { name: 'Save', exact: true }).click();
  const sidebar = page.locator('.document-comments'); await sidebar.locator('summary').click();
  await expect(sidebar).toContainText('Synthetic native comment retained after failed deletion.');
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
