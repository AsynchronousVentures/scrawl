// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createBrowserDemo, type BrowserDemo } from './fixture.js';
import type { DemoBResult } from '../../scripts/demo-b.js';
import type { DemoRole } from '../../scripts/demo-config.js';
import type { operations } from '../../web/src/api/schema.js';
import { editDocument, readingTitle, replaceDocumentBody } from './editor-mode.js';

type Document = operations['readDocument']['responses'][200]['content']['application/json'];
let demo: BrowserDemo, seeded: DemoBResult;
test.beforeAll(async () => { demo = await createBrowserDemo(); });
test.afterAll(async () => { await demo?.close(); });
test.beforeEach(async () => { seeded = await demo.seed(); });
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Documents', exact: true });
const notification = (page: Page) => page.getByRole('dialog', { name: 'Notification', exact: true });
const body = (page: Page) => page.getByRole('textbox', { name: 'Document body', exact: true });
const slugRead = (doc: Document) => `**/api/v1/spaces/${doc.spaceId}/documents/by-slug/${doc.slug}`;

async function login(page: Page, role: DemoRole = 'editor') {
  await page.goto(`${demo.origin}/?space=${seeded.spaceId}&document=${seeded.documentId}`);
  await demo.fillCredentials(page.getByLabel('Email', { exact: true }), page.getByLabel('Password', { exact: true }), role);
  await page.getByRole('button', { name: 'Log in', exact: true }).click(); demo.authenticationCompleted();
  await expect(readingTitle(page)).toBeVisible();
}
async function read(context: BrowserContext, id = seeded.documentId) {
  const response = await context.request.get(`${demo.origin}/api/v1/documents/${id}`);
  expect(response.status()).toBe(200);
  return await response.json() as Document;
}
async function create(context: BrowserContext, title: string, parentDocumentId?: string) {
  const baseline = await read(context);
  const response = await context.request.post(`${demo.origin}/api/v1/spaces/${seeded.spaceId}/documents`, {
    headers: { origin: demo.origin }, data: { title, content: baseline.revision.content, ...(parentDocumentId ? { parentDocumentId } : {}) },
  });
  expect(response.status()).toBe(201);
  return await response.json() as Document;
}
async function copyLink(page: Page) {
  await page.getByLabel('Document actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Copy private link', exact: true }).click();
  await expect(notification(page)).toContainText('Private link copied.');
}

test('warm navigation keeps the tree and page geometry while reading fresh content, and ignores a superseded response', async ({ page, context }) => {
  await login(page);
  const second = await create(context, 'Second handbook'), third = await create(context, 'Third handbook');
  await create(context, 'Second handbook child', second.id);
  await page.reload(); await expect(readingTitle(page)).toBeVisible();
  const disclosure = navigation(page).getByRole('button', { name: 'Child documents of Second handbook' });
  await disclosure.click(); await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const tree = await navigation(page).elementHandle(), editor = await body(page).elementHandle();
  const before = await page.locator('#document-title').boundingBox();
  let spaceLists = 0, targetReads = 0, release = () => {}, settled = () => {};
  const completed = new Promise<void>(resolve => { settled = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v1/spaces') spaceLists++;
  });
  await page.route(slugRead(second), async route => {
    targetReads++;
    const response = await route.fetch(); await gate;
    try { await route.fulfill({ response }); } catch { /* A superseded navigation may cancel the read. */ } finally { settled(); }
  });
  try {
    await navigation(page).getByRole('link', { name: 'Second handbook', exact: true }).click();
    await expect(page.locator('main > .sr[role=status]')).toBeVisible();
    expect(await tree!.evaluate(element => element.isConnected)).toBe(true);
    expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
    expect(await page.locator('#document-title').boundingBox()).toEqual(before);
    await expect(page.locator('main [inert]')).toHaveCount(1);
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Loading documents…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Loading favorites…', { exact: true })).toHaveCount(0);
    await navigation(page).getByRole('link', { name: 'Third handbook', exact: true }).click();
    await expect(readingTitle(page)).toHaveText(third.revision.title);
    release(); await completed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect.poll(() => targetReads).toBe(1);
    await page.unroute(slugRead(second));
    await expect(readingTitle(page)).toHaveText(third.revision.title);
    expect(await tree!.evaluate(element => element.isConnected)).toBe(true);
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(spaceLists).toBe(0);
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    expect((await read(context, second.id)).currentRevisionNumber).toBe(1);
  } finally { release(); }
});

test('dirty navigation keeps the editor and performs no target read before deliberate discard', async ({ page, context }) => {
  await login(page); const next = await create(context, 'Navigation target');
  await page.reload(); await editDocument(page);
  await page.getByLabel('Document title', { exact: true }).fill('Local title');
  await replaceDocumentBody(page, 'Complete retained local body.');
  const editor = await body(page).elementHandle(); let reads = 0;
  page.on('request', request => { if (request.url().includes(`/documents/by-slug/${next.slug}`)) reads++; });
  await navigation(page).getByRole('link', { name: next.revision.title, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  expect(reads).toBe(0); expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
  await expect(body(page)).toHaveText('Complete retained local body.');
  await expect(page.getByLabel('Document title', { exact: true })).toHaveValue('Local title');
  await navigation(page).getByRole('link', { name: next.revision.title, exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(readingTitle(page)).toHaveText(next.revision.title); expect(reads).toBe(1);
  expect((await read(context)).currentRevisionNumber).toBe(1);
});

test('warm navigation rechecks current grants and clears the previous document on denial', async ({ page, context, browser }) => {
  await login(page); const next = await create(context, 'Permission target');
  await page.reload(); await expect(readingTitle(page)).toBeVisible();
  const admin = await browser.newContext();
  try {
    const adminPage = await admin.newPage(); await login(adminPage, 'administrator');
    const me = await context.request.get(`${demo.origin}/api/v1/me`);
    const account = await me.json() as { id: string };
    const members = await admin.request.get(`${demo.origin}/api/v1/spaces/${seeded.spaceId}/members`);
    const revoked = await admin.request.delete(`${demo.origin}/api/v1/spaces/${seeded.spaceId}/members/${account.id}`, {
      headers: { origin: demo.origin, 'if-match': members.headers().etag! },
    }); expect(revoked.status()).toBe(200);
    await page.bringToFront();
    await navigation(page).getByRole('link', { name: next.revision.title, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Access to this document is unavailable.');
    await expect(readingTitle(page)).toHaveCount(0); await expect(body(page)).toHaveCount(0);
    await expect(navigation(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    expect((await context.request.get(`${demo.origin}/api/v1/me`)).status()).toBe(200);
  } finally { await admin.close(); }
});

test('warm read failure removes the previous content and Retry reads only the requested document', async ({ page, context }) => {
  await login(page); const next = await create(context, 'Retry target');
  await page.reload(); await expect(readingTitle(page)).toBeVisible();
  await page.route(slugRead(next), route => route.fulfill({ status: 503 }));
  await navigation(page).getByRole('link', { name: next.revision.title, exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(readingTitle(page)).toHaveCount(0); await expect(body(page)).toHaveCount(0);
  await expect(navigation(page)).toBeVisible();
  await page.unroute(slugRead(next));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(readingTitle(page)).toHaveText(next.revision.title);
  expect((await read(context, next.id)).currentRevisionNumber).toBe(1);
});

test('canonical space paths take precedence over legacy query hints during warm navigation', async ({ page, context }) => {
  await login(page); const original = await read(context);
  const target = `/spaces/unknown-space/documents/${original.slug}?space=${seeded.spaceId}&document=${seeded.documentId}`;
  // Exercise a same-tab history destination, rather than a cold page reload.
  await page.evaluate(path => {
    history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate'));
  }, target);
  await expect(page.getByRole('alert')).toContainText('Access to this document is unavailable.');
  await expect(readingTitle(page)).toHaveCount(0); await expect(body(page)).toHaveCount(0);
  await expect(navigation(page)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(`/spaces/unknown-space/documents/${original.slug}`);
});

test('copy confirmations are keyboard dismissible toasts without document jumps, repeat correctly and expire', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: demo.origin });
  await login(page); const baseline = await read(context);
  const titleBox = await readingTitle(page).boundingBox();
  await copyLink(page);
  expect(await readingTitle(page).boundingBox()).toEqual(titleBox);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  await expect(page.getByLabel('Document actions', { exact: true })).toBeFocused();
  await copyLink(page); await expect(notification(page)).toHaveCount(1);
  await page.keyboard.press('F6');
  await expect(page.getByLabel('Notifications (F6)', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(notification(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(notification(page).getByRole('button', { name: 'Dismiss notification' })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(notification(page)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await copyLink(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.mouse.move(0, 0);
  await expect(notification(page)).toHaveCount(0, { timeout: 9000 });
  expect(await read(context)).toEqual(baseline);
});
