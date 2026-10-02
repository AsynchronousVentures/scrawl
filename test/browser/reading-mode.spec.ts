// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createBrowserDemo, type BrowserDemo } from './fixture.js';
import type { DemoBResult } from '../../scripts/demo-b.js';
import type { DemoRole } from '../../scripts/demo-config.js';
import type { operations } from '../../web/src/api/schema.js';
import { richDemoContent } from '../../scripts/demo-content.js';
import { replaceDocumentBody } from './editor-mode.js';

let demo: BrowserDemo, seeded: DemoBResult;
test.beforeAll(async () => { demo = await createBrowserDemo({ collaboration: true }); });
test.afterAll(async () => { await demo?.close(); });
test.beforeEach(async () => { seeded = await demo.seed(); });
const body = (page: Page) => page.getByRole('textbox', { name: 'Document body', exact: true });
const title = (page: Page) => page.getByRole('textbox', { name: 'Document title', exact: true });
const heading = (page: Page) => page.locator('h1#document-title');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function login(page: Page, role: DemoRole = 'editor') {
  await page.goto(`${demo.origin}/?space=${seeded.spaceId}&document=${seeded.documentId}`);
  await demo.fillCredentials(page.getByLabel('Email', { exact: true }), page.getByLabel('Password', { exact: true }), role);
  await button(page, 'Log in').click(); demo.authenticationCompleted();
  await expect(button(page, 'Log out')).toBeVisible();
}
async function saved(context: BrowserContext) {
  const response = await context.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}`);
  expect(response.status()).toBe(200);
  return { etag: response.headers().etag!, document: await response.json() as operations['readDocument']['responses'][200]['content']['application/json'] };
}
async function reading(page: Page) {
  await expect(heading(page)).toBeVisible();
  await expect(title(page)).toHaveCount(0);
  await expect(body(page)).toHaveAttribute('contenteditable', 'false');
  await expect(body(page)).toHaveAttribute('aria-readonly', 'true');
  await expect(button(page, 'Save')).toHaveCount(0);
  await expect(button(page, 'Discard changes')).toHaveCount(0);
}
async function edit(page: Page) {
  await button(page, 'Edit').focus(); await page.keyboard.press('Enter');
  await expect(title(page)).toBeFocused();
  await expect(body(page)).toBeEditable();
}

test('documents open read-only, Edit is explicit and Save preserves native undo before returning to reading', async ({ page, context }) => {
  await login(page); await reading(page);
  const baseline = await saved(context), text = await body(page).innerText();
  let writes = 0;
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(`/documents/${seeded.documentId}`)) writes++; });
  await body(page).focus(); await page.keyboard.type('Accidental typing');
  await expect(body(page)).toHaveText(text, { useInnerText: true }); expect(writes).toBe(0);
  await expect(page.locator('.bn-side-menu')).not.toBeVisible();
  expect(await saved(context)).toEqual(baseline);
  await edit(page);
  await title(page).fill('Explicit editing'); await replaceDocumentBody(page, 'A deliberately saved paragraph.');
  await button(page, 'Save').click();
  await expect(page.getByText(`Saved · revision ${baseline.document.currentRevisionNumber + 1}`, { exact: true })).toBeVisible();
  await expect(body(page)).toBeEditable();
  await body(page).press('ControlOrMeta+z');
  await expect(body(page)).toHaveText(text, { useInnerText: true });
  await body(page).press('ControlOrMeta+Shift+z');
  await expect(body(page)).toHaveText('A deliberately saved paragraph.');
  await expect(button(page, 'Save')).toBeDisabled();
  await button(page, 'Done editing').click(); await reading(page);
  await expect(heading(page)).toHaveText('Explicit editing'); await expect(heading(page)).toBeFocused();
  await edit(page); await body(page).press('ControlOrMeta+z');
  await expect(body(page)).toHaveText(text, { useInnerText: true });
  await body(page).press('ControlOrMeta+Shift+z');
  await expect(body(page)).toHaveText('A deliberately saved paragraph.');
  await expect(button(page, 'Save')).toBeDisabled();
  await button(page, 'Done editing').click(); await reading(page);
  await page.reload(); await reading(page);
  await expect(body(page)).toHaveText('A deliberately saved paragraph.');
  expect(writes).toBe(1);
  expect((await saved(context)).document.currentRevisionNumber).toBe(baseline.document.currentRevisionNumber + 1);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('leaving edit mode protects the complete draft and confirmed discard changes no history or ETag', async ({ page, context }) => {
  await login(page); await reading(page); const baseline = await saved(context), original = await body(page).innerText();
  await edit(page); await title(page).fill('Unsaved title'); await replaceDocumentBody(page, 'Complete unsaved body.');
  await button(page, 'Done editing').click();
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(title(page)).toBeFocused(); await expect(title(page)).toHaveValue('Unsaved title');
  await expect(body(page)).toHaveText('Complete unsaved body.');
  await button(page, 'Discard changes').click();
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(title(page)).toHaveValue(baseline.document.revision.title); await expect(body(page)).toHaveText(original, { useInnerText: true });
  await expect(body(page)).toBeEditable(); expect(await saved(context)).toEqual(baseline);
  await title(page).fill('Second unsaved title'); await replaceDocumentBody(page, 'Second local body.');
  await button(page, 'Done editing').click(); await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await reading(page); await expect(heading(page)).toHaveText(baseline.document.revision.title);
  await expect(body(page)).toHaveText(original, { useInnerText: true }); expect(await saved(context)).toEqual(baseline);
});

test('reading rich blocks permits section navigation while keeping checklists and tables immutable', async ({ page, context }) => {
  await login(page); const original = await saved(context);
  expect((await context.request.patch(`${demo.origin}/api/v1/documents/${seeded.documentId}`, {
    headers: { origin: demo.origin, 'if-match': original.etag }, data: { content: richDemoContent(['Reading rich content.']) },
  })).status()).toBe(200);
  await page.reload(); await reading(page); const baseline = await saved(context);
  const checklist = body(page).getByRole('checkbox');
  await expect(checklist).toBeChecked(); await expect(checklist).toBeDisabled();
  await expect(body(page).getByRole('table')).toContainText('Preserved');
  const outline = page.getByRole('navigation', { name: 'On this page', exact: true });
  await outline.getByRole('link', { name: 'Nested review notes', exact: true }).click();
  await expect(body(page).getByRole('heading', { name: 'Nested review notes', exact: true })).toBeFocused();
  await expect(button(page, 'Save')).toHaveCount(0); expect(await saved(context)).toEqual(baseline);
  await edit(page); await expect(checklist).toBeEnabled(); await checklist.uncheck();
  await expect(button(page, 'Save')).toBeEnabled(); expect(await saved(context)).toEqual(baseline);
  await button(page, 'Done editing').click();
  await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await reading(page); await expect(checklist).toBeChecked(); await expect(checklist).toBeDisabled();
  expect(await saved(context)).toEqual(baseline);
});

test('a pending Save locks native checklist controls without changing their visible state or losing undo', async ({ page, context }) => {
  await login(page); const original = await saved(context);
  expect((await context.request.patch(`${demo.origin}/api/v1/documents/${seeded.documentId}`, {
    headers: { origin: demo.origin, 'if-match': original.etag }, data: { content: richDemoContent(['Pending save checklist.']) },
  })).status()).toBe(200);
  await page.reload(); await reading(page); const baseline = await saved(context); await edit(page);
  const checklist = body(page).getByRole('checkbox');
  await checklist.uncheck(); await expect(button(page, 'Save')).toBeEnabled();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/documents/${seeded.documentId}`, async route => {
    if (route.request().method() === 'PATCH') await gate;
    await route.continue();
  });
  try {
    const request = page.waitForRequest(request => request.method() === 'PATCH');
    await button(page, 'Save').click(); await request;
    await expect(page.locator('.editor-mount[inert]')).toHaveCount(1);
    // Send actual pointer/keyboard input; do not dispatch a synthetic change event.
    await checklist.scrollIntoViewIfNeeded();
    const bounds = await checklist.boundingBox(); expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.keyboard.press('Space');
    await expect(checklist).not.toBeChecked();
    expect(await page.locator('.editor-mount').evaluate(element => element.contains(document.activeElement))).toBe(false);
    release();
    await expect(page.getByText(`Saved · revision ${baseline.document.currentRevisionNumber + 1}`, { exact: true })).toBeVisible();
    await expect(page.locator('.editor-mount[inert]')).toHaveCount(0);
    await expect(checklist).not.toBeChecked();
    const committed = await saved(context);
    expect(committed.document.revision.content).toMatchObject({ document: expect.arrayContaining([
      expect.objectContaining({ id: 'demo-rich-bullet', children: expect.arrayContaining([
        expect.objectContaining({ id: 'demo-rich-check', type: 'checkListItem', props: expect.objectContaining({ checked: false }) }),
      ]) }),
    ]) });
    await body(page).press('ControlOrMeta+z'); await expect(checklist).toBeChecked();
    await expect(button(page, 'Save')).toBeEnabled(); expect(await saved(context)).toEqual(committed);
  } finally { release(); }
});

test('failed and stale saves keep editing and the full local draft until deliberate reconciliation', async ({ page, context }) => {
  await login(page); await edit(page); const baseline = await saved(context);
  await title(page).fill('Local title kept'); await replaceDocumentBody(page, 'Local body kept in full.');
  let writes = 0;
  await page.route(`**/api/v1/documents/${seeded.documentId}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    writes++; await route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ status: 503 }) });
  });
  await button(page, 'Save').click(); await expect(page.getByRole('alert')).toContainText('Your complete local draft is retained');
  await expect(title(page)).toHaveValue('Local title kept'); await expect(body(page)).toHaveText('Local body kept in full.');
  expect(await saved(context)).toEqual(baseline); expect(writes).toBe(1);
  await page.unroute(`**/api/v1/documents/${seeded.documentId}`);
  expect((await context.request.patch(`${demo.origin}/api/v1/documents/${seeded.documentId}`, {
    headers: { origin: demo.origin, 'if-match': baseline.etag }, data: { title: 'Newer server title' },
  })).status()).toBe(200);
  await button(page, 'Save').click();
  await expect(page.getByRole('complementary', { name: 'Save conflict' })).toBeVisible();
  await expect(title(page)).toHaveValue('Local title kept'); await expect(body(page)).toHaveText('Local body kept in full.');
  await expect(button(page, 'Save')).toBeDisabled();
  await button(page, 'Done editing').click();
  await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Keep editing' }).click();
  await expect(button(page, 'Save')).toBeDisabled();
  expect((await saved(context)).document.currentRevisionNumber).toBe(baseline.document.currentRevisionNumber + 1);
  await button(page, 'Use my changes').click(); await button(page, 'Save').click();
  await expect(button(page, 'Save')).toBeDisabled();
  await expect(page.getByText(`Saved · revision ${baseline.document.currentRevisionNumber + 2}`, { exact: true })).toBeVisible();
  const final = await saved(context); expect(final.document.revision.title).toBe('Local title kept');
  expect(final.document.revision.plainText).toBe('Local body kept in full.');
});

test('readers remain read-only and outsiders never receive a document or edit action', async ({ page, context, browser }) => {
  await login(page, 'reader'); await reading(page); await expect(button(page, 'Edit')).toHaveCount(0);
  const baseline = await saved(context);
  await button(page, 'History').click(); await expect(page.getByRole('complementary', { name: 'Revision history' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Restore revision/ })).toHaveCount(0);
  expect((await context.request.patch(`${demo.origin}/api/v1/documents/${seeded.documentId}`, {
    headers: { origin: demo.origin, 'if-match': baseline.etag }, data: { title: 'Forbidden title' },
  })).status()).toBe(404);
  expect(await saved(context)).toEqual(baseline);
  const outside = await browser.newContext();
  try {
    const outsider = await outside.newPage(); await login(outsider, 'outsider');
    await expect(heading(outsider)).toHaveCount(0); await expect(body(outsider)).toHaveCount(0);
    await expect(button(outsider, 'Edit')).toHaveCount(0);
    await expect(outsider.getByRole('navigation', { name: 'Documents', exact: true })).toHaveCount(0);
  } finally { await outside.close(); }
});

test('new drafts start editable and saved navigation, archive and unarchive return to reading on mobile', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await reading(page);
  const baseline = await saved(context), originalUrl = page.url();
  await button(page, 'Navigation').click(); await button(page, 'New document').click();
  await expect(title(page)).toBeFocused(); await expect(body(page)).toBeEditable();
  await title(page).fill('New document ' + 'W'.repeat(170)); await replaceDocumentBody(page, 'A mobile document.');
  await button(page, 'Save').click(); await expect(page.getByText('Saved · revision 1', { exact: true })).toBeVisible();
  await button(page, 'Done editing').click(); await reading(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(originalUrl); await reading(page); await expect(heading(page)).toHaveText(baseline.document.revision.title);
  for (const action of ['Archive', 'Unarchive']) {
    await page.getByLabel('Document actions', { exact: true }).click(); await button(page, action).click();
    await expect(page.getByText(`${action === 'Archive' ? 'Archived' : 'Saved'} · revision ${baseline.document.currentRevisionNumber}`, { exact: true })).toBeVisible();
    await reading(page);
    if (action === 'Archive') await expect(button(page, 'Edit')).toHaveCount(0);
    else await expect(button(page, 'Edit')).toBeEnabled();
  }
  expect((await saved(context)).document.revision).toEqual(baseline.document.revision);
});

test('a live observer receives peer updates without entering edit mode or writing a checkpoint', async ({ page, context, browser }) => {
  await login(page); await reading(page);
  await page.getByLabel('Document actions', { exact: true }).click(); await button(page, 'Enable shared editing').click();
  await expect(body(page)).toBeEditable();
  const baseline = await saved(context), observerContext = await browser.newContext();
  try {
    const observer = await observerContext.newPage(); await login(observer, 'administrator');
    await expect(observer.locator('.document-comments > summary')).toBeVisible(); await reading(observer);
    await title(page).fill('Shared title while reading');
    await expect(heading(observer)).toHaveText('Shared title while reading');
    await body(page).press('ControlOrMeta+End'); await page.keyboard.press('Enter'); await page.keyboard.type('A shared paragraph.');
    await expect(body(observer)).toContainText('A shared paragraph.');
    await reading(observer); expect(await saved(context)).toEqual(baseline);
    await edit(observer); await expect(title(observer)).toHaveValue('Shared title while reading');
    await expect(body(observer)).toContainText('A shared paragraph.');
    await title(observer).fill('Observer deliberately edited');
    await expect(title(page)).toHaveValue('Observer deliberately edited');
    await button(observer, 'Done editing').click(); await reading(observer);
    await expect(heading(observer)).toHaveText('Observer deliberately edited');
    await expect(title(page)).toHaveValue('Observer deliberately edited');
    await expect(observer.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0);
    expect(await saved(context)).toEqual(baseline);
  } finally { await observerContext.close(); }
});
