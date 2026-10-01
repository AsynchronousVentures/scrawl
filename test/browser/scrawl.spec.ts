// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
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

async function navigationDocument(context: BrowserContext) {
  const original = await readDocument(context);
  const created = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { origin: demo.origin }, data: { title: 'Another handbook', content: original.data.revision.content },
  });
  expect(created.status()).toBe(201);
  const value: unknown = await created.json();
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('Missing created document identity');
  return (await readDocument(context, value.id)).data;
}

test('copy private link uses the saved readable URL without saving drafts or granting recipient access', async ({ page, context, browser }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: demo.origin });
  await login(page);
  const original = await readDocument(context);
  const canonical = `${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}`;
  await title(page).fill('Unsent title must not appear in the copied link');
  await body(page).fill('Complete unsaved body stays in the editor.');
  await page.getByLabel('Document actions', { exact: true }).focus(); await page.keyboard.press('Enter');
  const copy = page.getByRole('button', { name: 'Copy private link', exact: true });
  await copy.focus(); await evidence(page, 'private-link'); await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Private link copied. Only people with space access can open it.' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(canonical);
  await expect(page.getByLabel('Document actions', { exact: true })).toBeFocused();
  await expect(title(page)).toHaveValue('Unsent title must not appear in the copied link');
  await expect(body(page)).toHaveText('Complete unsaved body stays in the editor.');
  expect(await readDocument(context)).toEqual(original);
  const reader = await browser.newContext(), outsider = await browser.newContext();
  try {
    const readerPage = await reader.newPage(); await login(readerPage, 'reader', copied);
    await expect(title(readerPage)).toHaveValue(original.data.revision.title);
    await expect(body(readerPage)).not.toBeEditable();
    await readerPage.getByLabel('Document actions', { exact: true }).click();
    await expect(readerPage.getByRole('button', { name: 'Copy private link', exact: true })).toBeEnabled();
    const outsiderPage = await outsider.newPage(); await login(outsiderPage, 'outsider', copied);
    await expect(title(outsiderPage)).toHaveCount(0);
    await expect(outsiderPage.getByRole('button', { name: 'Copy private link', exact: true })).toHaveCount(0);
    await expect(outsiderPage.getByRole('link', { name: original.data.revision.title, exact: true })).toHaveCount(0);
    const denied = await outsider.request.get(`${demo.origin}/api/v1/spaces/${seeded.spaceId}/documents/by-slug/${original.data.slug}`);
    expect(denied.status()).toBe(404);
    expect(await readDocument(context)).toEqual(original);
  } finally { await reader.close(); await outsider.close(); }
});

test('a browser clipboard-policy denial retains drafts and never reports a successful copy or save', async ({ page, context }) => {
  const runtimeErrors: string[] = []; page.on('pageerror', error => runtimeErrors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: demo.origin });
  await page.route(url(), async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'permissions-policy': 'clipboard-write=()' } });
  });
  await login(page); const original = await readDocument(context);
  await title(page).fill('Draft retained after denied clipboard access');
  await body(page).fill('The browser refused the copy, not the save.');
  await page.getByLabel('Document actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Copy private link', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copy is unavailable. Copy the document URL from your browser address bar.' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Private link copied.' })).toHaveCount(0);
  await expect(title(page)).toHaveValue('Draft retained after denied clipboard access');
  await expect(body(page)).toHaveText('The browser refused the copy, not the save.');
  await expect(save(page)).toBeEnabled();
  expect(await readDocument(context)).toEqual(original);
  expect(runtimeErrors).toEqual([]);
});

test('document links support Back/Forward and opening a separate tab without disturbing a draft', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context), second = await navigationDocument(context);
  await page.reload();
  await expect(page).toHaveURL(`${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}`);
  const originalUrl = page.url(), secondUrl = `${demo.origin}/spaces/${second.spaceSlug}/documents/${second.slug}`;
  await page.getByRole('link', { name: 'Another handbook', exact: true }).click();
  await expect(page).toHaveURL(secondUrl);
  await expect(title(page)).toHaveValue('Another handbook');
  await page.goBack();
  await expect(page).toHaveURL(originalUrl);
  await expect(title(page)).toHaveValue(original.data.revision.title);
  await page.goForward();
  await expect(title(page)).toHaveValue('Another handbook');
  await title(page).fill('Complete local draft in the current tab');
  await body(page).fill('Unsaved body stays here while another tab opens.');
  await page.getByRole('link', { name: original.data.revision.title, exact: true }).click({ modifiers: ['ControlOrMeta'] });
  // Opener isolation can replace the initial about:blank target. Observe the
  // actual rendered native tab rather than keeping that transient page handle.
  let opened: Page | undefined;
  await expect.poll(async () => {
    for (const candidate of context.pages()) {
      if (candidate === page || candidate.isClosed() || candidate.url() !== originalUrl) continue;
      try {
        if (await title(candidate).count() === 1) { opened = candidate; return true; }
      } catch { /* A transient target can close during opener isolation. */ }
    }
    return false;
  }).toBe(true);
  if (!opened) throw new Error('The native document tab did not finish loading');
  try {
    await expect(opened).toHaveURL(originalUrl);
    await expect(title(opened)).toHaveValue(original.data.revision.title);
    await expect(title(page)).toHaveValue('Complete local draft in the current tab');
    await expect(body(page)).toContainText('Unsaved body stays here while another tab opens.');
    await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0);
    expect((await readDocument(context, second.id)).data).toEqual(second);
    await assertNoBrowserPersistence(page);
  } finally { await opened.close(); }
});

test('Back and Forward require deliberate discard and Keep editing preserves the complete draft without writes', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context), second = await navigationDocument(context);
  await page.reload();
  await expect(page).toHaveURL(`${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}`);
  const originalUrl = page.url();
  await page.getByRole('link', { name: 'Another handbook', exact: true }).click();
  await expect(title(page)).toHaveValue('Another handbook');
  const secondUrl = page.url();
  await title(page).fill('Unsent title'); await body(page).fill('Unsent body, retained after canceled Back.');
  let writes = 0;
  page.on('request', request => { if (['PATCH', 'POST', 'DELETE'].includes(request.method())) writes++; });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => history.back());
    const dialog = page.getByRole('dialog', { name: 'Unsaved changes' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(page).toHaveURL(secondUrl);
    await expect(title(page)).toHaveValue('Unsent title');
    await expect(body(page)).toContainText('Unsent body, retained after canceled Back.');
  }
  await page.evaluate(() => history.back());
  await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL(originalUrl);
  await expect(title(page)).toHaveValue(original.data.revision.title);
  await title(page).fill('Unsent original title'); await body(page).fill('Complete forward draft.');
  await page.evaluate(() => history.forward());
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page).toHaveURL(originalUrl);
  await expect(title(page)).toHaveValue('Unsent original title');
  await expect(body(page)).toContainText('Complete forward draft.');
  await page.evaluate(() => history.forward());
  await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(title(page)).toHaveValue('Another handbook');
  expect(writes).toBe(0);
  expect(await readDocument(context)).toEqual(original);
  expect((await readDocument(context, second.id)).data).toEqual(second);
});

test('Back cannot abandon an in-flight explicit Save and a committed save adds only one revision', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context), second = await navigationDocument(context);
  await page.reload();
  await expect(page).toHaveURL(`${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}`);
  const originalUrl = page.url();
  await page.getByRole('link', { name: 'Another handbook', exact: true }).click();
  await expect(title(page)).toHaveValue('Another handbook');
  await title(page).fill('Saved despite Back during request');
  await body(page).fill('Complete saved body.');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/documents/${second.id}`, async route => {
    if (route.request().method() === 'PATCH') await held;
    await route.continue();
  });
  try {
    const request = page.waitForRequest(request => request.method() === 'PATCH');
    await save(page).click(); await request;
    await page.evaluate(() => history.back());
    const wait = page.getByRole('dialog', { name: 'Please wait' });
    await expect(wait).toBeVisible();
    await expect(wait.getByRole('button', { name: 'Discard changes' })).toBeDisabled();
    release();
    await expect(save(page)).toBeDisabled();
    await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const saved = await readDocument(context, second.id);
    expect(saved.data.currentRevisionNumber).toBe(2);
    expect(saved.data.revision.title).toBe('Saved despite Back during request');
    expect(saved.data.revision.plainText).toContain('Complete saved body.');
    await page.goBack();
    await expect(page).toHaveURL(originalUrl);
    await expect(title(page)).toHaveValue(original.data.revision.title);
  } finally { release(); }
});

test('readable document links survive login, reload, title changes and legacy bookmarks', async ({ page, context, browser }) => {
  await login(page);
  const original = await readDocument(context);
  const readable = `${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}`;
  await expect(page).toHaveURL(readable);
  await title(page).fill('Renamed handbook with a stable link');
  await explicitSave(page);
  await expect(page).toHaveURL(readable);
  await page.reload();
  await expect(title(page)).toHaveValue('Renamed handbook with a stable link');
  await page.goto(url());
  await expect(title(page)).toHaveValue('Renamed handbook with a stable link');
  await expect(page).toHaveURL(readable);

  const readerContext = await browser.newContext(), outsiderContext = await browser.newContext();
  try {
    const reader = await readerContext.newPage();
    await login(reader, 'reader', readable);
    await expect(title(reader)).toHaveValue('Renamed handbook with a stable link');
    await expect(title(reader)).toHaveAttribute('readonly', '');
    const outsider = await outsiderContext.newPage();
    await login(outsider, 'outsider', readable);
    await expect(title(outsider)).toHaveCount(0);
    await expect(body(outsider)).toHaveCount(0);
    await expect(outsider.getByRole('navigation', { name: 'Documents', exact: true })).toHaveCount(0);
    expect((await apiRequest(outsiderContext, `/api/v1/spaces/${seeded.spaceId}/documents/by-slug/${original.data.slug}`)).status()).toBe(404);
  } finally { await readerContext.close(); await outsiderContext.close(); }
});

test('unknown slug links show no unrelated space or document and never fall back to the first item', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context);
  await page.goto(`${demo.origin}/spaces/${original.data.spaceSlug}/documents/not-a-document`);
  await expect(page.getByRole('alert')).toContainText('Access to this document is unavailable.');
  await expect(title(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Documents', exact: true })).toHaveCount(0);
  await page.goto(`${demo.origin}/spaces/not-a-space/documents/not-a-document`);
  await expect(page.getByRole('alert')).toContainText('Access to this document is unavailable.');
  await expect(title(page)).toHaveCount(0);
  expect(await readDocument(context)).toEqual(original);
});
function title(page: Page) { return page.getByRole('textbox', { name: 'Document title', exact: true }); }
function body(page: Page) { return page.getByRole('textbox', { name: 'Document body', exact: true }); }
function save(page: Page) { return page.getByRole('button', { name: 'Save', exact: true }); }
async function selectedBlockId(page: Page) {
  return body(page).evaluate(element => element.ownerDocument.getSelection()?.anchorNode?.parentElement
    ?.closest('[data-id]')?.getAttribute('data-id') ?? null);
}
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
  | 'organization' | 'organization-depth' | 'private-link' | 'editor-toolbar' | 'link-editor' | 'discard-changes' | 'search' | 'attachments' | 'publication' | 'public-document') {
  if (process.env.SCRAWL_BROWSER_EVIDENCE !== '1') return;
  const password = page.getByLabel('Password', { exact: true });
  if (await password.isVisible() && await password.inputValue() !== '') {
    throw new Error('Screenshot refused while private credentials are present');
  }
  await mkdir('artifacts/browser-evidence', { recursive: true, mode: 0o700 });
  await page.screenshot({ path: `artifacts/browser-evidence/${name}.png`, fullPage: false, mask: [page.locator('.account')], maskColor: '#1a1d20' });
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

test('real search finds authorized saved text across spaces and keeps dirty edits until deliberate navigation', async ({ page, context }) => {
  const other = await demo.seed();
  await demo.database.prisma.space.update({ where: { id: other.spaceId }, data: { name: 'Synthetic engineering' } });
  await login(page);
  const token = `search${randomUUID().replaceAll('-', '')}`;
  const targetTitle = `Synthetic search target ${token}`;
  const created = await apiRequest(context, `/api/v1/spaces/${other.spaceId}/documents`, {
    method: 'POST', headers: { Origin: demo.origin }, data: {
      title: targetTitle, content: nativeContent([paragraph('search-target', `Saved body ${token} with a readable result excerpt.`)]),
    },
  });
  expect(created.status()).toBe(201);
  const local = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { Origin: demo.origin }, data: {
      title: targetTitle, content: nativeContent([paragraph('local-search-target', `Local saved body ${token}.`)]),
    },
  });
  expect(local.status()).toBe(201);
  const target: unknown = await created.json();
  if (!target || typeof target !== 'object' || !('id' in target) || typeof target.id !== 'string') throw new Error('Search fixture was not created');
  const baseline = await readDocument(context);
  await title(page).fill('Unsaved title retained while searching');
  await body(page).fill('The full unsaved body survives search and cancel.');
  await title(page).focus();
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('dialog', { name: 'Search documents', exact: true });
  const query = search.getByRole('combobox', { name: 'Search accessible documents', exact: true });
  await expect(query).toBeFocused();
  await query.fill(token);
  const results = search.getByRole('listbox', { name: 'Search results', exact: true });
  await expect(results.getByRole('option')).toHaveCount(2);
  const scope = search.getByRole('combobox', { name: 'Search in', exact: true });
  await query.press('Tab');
  await expect(scope).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(scope).not.toHaveValue('');
  await expect(scope).toBeFocused();
  await scope.selectOption(seeded.spaceId);
  await expect(results.getByRole('option')).toHaveCount(1);
  await expect(results.getByRole('option')).toContainText('Demo B handbook');
  await expect(results.getByRole('option')).toContainText('Local saved body');
  const option = results.getByRole('option').filter({ hasText: targetTitle }).filter({ hasText: 'Synthetic engineering' });
  let release: () => void = () => {}, completed: () => void = () => {}, captured = false;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const settled = new Promise<void>(resolve => { completed = resolve; });
  await page.route(/\/api\/v1\/search\?/, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') !== token || url.searchParams.has('spaceId')) return route.continue();
    const response = await route.fetch(); captured = true;
    await delayed;
    try { await route.fulfill({ response }); } catch { /* The obsolete scope request can already be canceled. */ }
    finally { completed(); }
  });
  try {
    await scope.selectOption('');
    await expect.poll(() => captured).toBe(true);
    await expect(results.getByRole('option')).toHaveCount(0);
    await scope.selectOption(other.spaceId);
    await expect(option).toBeVisible();
    release(); await settled;
    await expect(results.getByRole('option')).toHaveCount(1);
    await expect(scope).toHaveValue(other.spaceId);
  } finally { release(); await page.unroute(/\/api\/v1\/search\?/); }
  await expect(option).toContainText('Synthetic engineering');
  await query.focus();
  await expect(option).toBeVisible();
  await expect(option).toContainText(`Saved body ${token}`);
  await evidence(page, 'search');
  await query.press('ArrowDown');
  await query.press('Enter');
  const discard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(title(page)).toHaveValue('Unsaved title retained while searching');
  await expect(body(page)).toHaveText('The full unsaved body survives search and cancel.');
  expect(await readDocument(context)).toEqual(baseline);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Search documents', exact: true }).click();
  await query.fill('Unsaved title retained while searching');
  await expect(search.getByRole('heading', { name: 'No matching documents', exact: true })).toBeVisible();
  await query.fill(token);
  await expect(option).toBeVisible();
  await scope.selectOption(other.spaceId);
  await expect(results.getByRole('option')).toHaveCount(1);
  const bounds = await search.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(376);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await option.click();
  await discard.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(title(page)).toHaveValue(targetTitle);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveValue(other.spaceId);
  const destination = await readDocument(context, target.id);
  expect(new URL(page.url()).pathname).toBe(`/spaces/${destination.data.spaceSlug}/documents/${destination.data.slug}`);
  expect(await readDocument(context)).toEqual(baseline);
  await assertNoBrowserPersistence(page);
});

test('search shows real loading, empty and failure states and ignores an obsolete query response', async ({ page }) => {
  await login(page);
  let requests = 0;
  let release: () => void = () => {};
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/v1\/search\?/, async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'release') {
      requests++;
      const response = await route.fetch();
      await delayed;
      try { await route.fulfill({ response }); } catch { /* The canceled obsolete request may already be closed. */ }
    } else if (query === 'temporary-failure') {
      await route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({
        type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'INTERNAL_ERROR', requestId: 'browser-search-fault',
      }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Search documents', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Search documents', exact: true });
  const query = search.getByRole('combobox', { name: 'Search accessible documents', exact: true });
  await query.fill('release');
  await expect(search.getByRole('status')).toHaveText('Searching…');
  await expect.poll(() => requests).toBe(1);
  await query.fill(`nomatch${randomUUID().replaceAll('-', '')}`);
  await expect(search.getByRole('heading', { name: 'No matching documents', exact: true })).toBeVisible();
  release();
  await expect(search.getByRole('listbox', { name: 'Search results', exact: true }).getByRole('option')).toHaveCount(0);
  await query.fill('temporary-failure');
  await expect(search.getByRole('alert')).toHaveText(/Search could not complete/);
  await expect(search.getByRole('listbox', { name: 'Search results', exact: true }).getByRole('option')).toHaveCount(0);
  await page.unroute(/\/api\/v1\/search\?/);
  await search.getByRole('button', { name: 'Retry search', exact: true }).click();
  await expect(search.getByRole('heading', { name: 'No matching documents', exact: true })).toBeVisible();
  await query.press('Escape');
  await expect(search).not.toBeVisible();
  await expect(title(page)).toHaveValue('Release checklist');
});

test('outsider search returns no private titles or excerpts through the real interface', async ({ page }) => {
  await login(page, 'outsider', demo.origin);
  await page.getByRole('button', { name: 'Search documents', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Search documents', exact: true });
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/search');
  await search.getByRole('combobox', { name: 'Search accessible documents', exact: true }).fill('release');
  const result = await response;
  expect(result.status()).toBe(200);
  expect(await result.json()).toEqual({ items: [] });
  await expect(search.getByRole('heading', { name: 'No matching documents', exact: true })).toBeVisible();
  await expect(search.getByRole('listbox', { name: 'Search results', exact: true }).getByRole('option')).toHaveCount(0);
  await expect(page.getByText('Release checklist', { exact: true })).toHaveCount(0);
});

test('native upload stores a private image, explicit Save references it, and reload/export preserve it', async ({ page, context }) => {
  await login(page);
  const baseline = await readDocument(context);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaGD4DwAChAGA+gVWHQAAAABJRU5ErkJggg==', 'base64');
  await body(page).fill('Uploaded native image body.');
  await slashBlock(page, 'image', 'Image');
  const uploaded = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/attachments`);
  await page.locator('.bn-panel input[type="file"]').setInputFiles({ name: 'Synthetic native image.png', mimeType: 'image/png', buffer: png });
  const response = await uploaded;
  expect(response.status()).toBe(201);
  const attachment: unknown = await response.json();
  if (!attachment || typeof attachment !== 'object' || !('url' in attachment) || typeof attachment.url !== 'string') throw new Error('Missing private attachment URL');
  const image = body(page).getByRole('img', { name: 'Synthetic native image.png', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth > 0)).toBe(true);
  await expect(page.getByText('Attachment uploaded. Save to include it in the document revision.', { exact: true })).toBeVisible();
  expect(await readDocument(context)).toEqual(baseline);
  await explicitSave(page);
  const saved = await readDocument(context);
  expect(saved.data.currentRevisionNumber).toBe(2);
  expect(saved.data.revision.content.document.find(block => block.type === 'image')).toMatchObject({
    type: 'image', props: { url: attachment.url, name: 'Synthetic native image.png' },
  });
  await page.reload();
  await expect(image).toBeVisible();
  await evidence(page, 'attachments');
  const native = await apiRequest(context, `/api/v1/documents/${seeded.documentId}/export`);
  expect(native.status()).toBe(200);
  const exported: unknown = await native.json();
  if (!exported || typeof exported !== 'object' || !('content' in exported)) throw new Error('Missing native export content');
  expect(validateContent(exported.content).content).toEqual(saved.data.revision.content);
  await assertNoBrowserPersistence(page);
});

test('a new native document enables supplied Upload after its first Save without discarding undo history', async ({ page, context }) => {
  await login(page);
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await title(page).fill('First saved attachment document');
  await body(page).fill('Native body before first Save.');
  await slashBlock(page, 'image', 'Image');
  await expect(page.getByRole('tab', { name: 'Upload', exact: true })).toHaveCount(0);
  await expect(page.getByText('Save this document before uploading attachments.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const created = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/spaces/${seeded.spaceId}/documents`);
  await save(page).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const document: unknown = await response.json();
  if (!document || typeof document !== 'object' || !('id' in document) || typeof document.id !== 'string') throw new Error('Missing first saved document');
  await expect(save(page)).toBeDisabled();
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(save(page)).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(save(page)).toBeDisabled();
  await body(page).getByText('Add image', { exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Upload', exact: true })).toBeVisible();
  expect((await readDocument(context, document.id)).data.currentRevisionNumber).toBe(1);
});

test('rapid new-draft navigation never inherits another document attachment authority or changes history', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context);
  let writes = 0;
  page.on('request', request => { if (['PATCH', 'POST', 'DELETE'].includes(request.method())) writes++; });
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.getByRole('button', { name: 'New document', exact: true }).click();
    await title(page).fill('Complete unsaved new document');
    await body(page).fill('Complete unsaved body.');
    await slashBlock(page, 'image', 'Image');
    await expect(page.getByRole('tab', { name: 'Upload', exact: true })).toHaveCount(0);
    await expect(page.getByText('Save this document before uploading attachments.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: original.data.revision.title, exact: true }).click();
    await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(title(page)).toHaveValue(original.data.revision.title);
  }
  expect(writes).toBe(0);
  expect(await readDocument(context)).toEqual(original);
});

test('a rejected native upload retains the entire local draft and creates no revision', async ({ page, context }) => {
  await login(page);
  const baseline = await readDocument(context);
  await title(page).fill('Unsaved title before rejected upload');
  await body(page).fill('Complete unsaved body before rejected upload.');
  await slashBlock(page, 'file', 'File');
  const uploaded = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/attachments`);
  await page.locator('.bn-panel input[type="file"]').setInputFiles({ name: 'Synthetic executable.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('This is a synthetic unsupported file.') });
  expect((await uploaded).status()).toBe(415);
  await expect(page.getByRole('alert').filter({ hasText: 'This file type is not supported.' })).toBeVisible();
  await expect(title(page)).toHaveValue('Unsaved title before rejected upload');
  await expect(body(page)).toContainText('Complete unsaved body before rejected upload.');
  expect(await readDocument(context)).toEqual(baseline);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  await page.keyboard.press('Escape');
  await confirmDiscard(page);
  await expect(title(page)).toHaveValue(baseline.data.revision.title);
  expect(await readDocument(context)).toEqual(baseline);
});

test('native JSON, PDF and DOCX downloads use saved current or selected history and never checkpoint dirty work', async ({ page, context }) => {
  await login(page);
  await title(page).fill('Synthetic saved file export');
  await body(page).fill('Saved text included in rendered exports.');
  await explicitSave(page);
  const saved = await readDocument(context);
  await title(page).fill('Unsaved title excluded from exported files');
  await body(page).fill('Unsaved body excluded from exported files.');
  for (const format of ['pdf', 'docx'] as const) {
    await actions(page);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: `Export ${format.toUpperCase()}`, exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`scrawl-synthetic-saved-file-export-revision-2.${format}`);
    const path = await file.path();
    if (!path) throw new Error('No rendered document download');
    const bytes = await readFile(path);
    let text: string;
    if (format === 'docx') {
      const document = (await JSZip.loadAsync(bytes)).file('word/document.xml');
      if (!document) throw new Error('DOCX has no document body');
      text = await document.async('text');
    } else {
      const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
      try {
        const document = await loading.promise;
        text = (await (await document.getPage(1)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
      } finally { await loading.destroy(); }
    }
    expect(text).toContain('Synthetic saved file export');
    expect(text).toContain('Saved text included in rendered exports.');
    expect(text).not.toContain('Unsaved title excluded');
    expect(text).not.toContain('Unsaved body excluded');
    await expect(title(page)).toHaveValue('Unsaved title excluded from exported files');
    await expect(body(page)).toHaveText('Unsaved body excluded from exported files.');
  }
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('complementary', { name: 'Revision history', exact: true });
  await history.getByRole('button', { name: 'Revision 1', exact: true }).click();
  const oldDownload = page.waitForEvent('download');
  const selected = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/exports/docx`
    && new URL(response.url()).searchParams.get('revisionId') === seeded.revisionId);
  await history.getByRole('button', { name: 'Export DOCX', exact: true }).click();
  expect((await selected).status()).toBe(200);
  const oldFile = await oldDownload;
  expect(oldFile.suggestedFilename()).toBe('scrawl-release-checklist-revision-1.docx');
  const oldPath = await oldFile.path();
  if (!oldPath) throw new Error('No selected revision download');
  const oldBody = (await JSZip.loadAsync(await readFile(oldPath))).file('word/document.xml');
  if (!oldBody) throw new Error('Selected DOCX has no body');
  expect(await oldBody.async('text')).toContain('Run tests before deploying.');
  expect(await oldBody.async('text')).not.toContain('Saved text included in rendered exports.');
  const nativeDownload = page.waitForEvent('download');
  const nativeResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/export`
    && new URL(response.url()).searchParams.get('revisionId') === seeded.revisionId);
  await history.getByRole('button', { name: 'Export JSON', exact: true }).click();
  expect((await nativeResponse).status()).toBe(200);
  const nativeFile = await nativeDownload;
  expect(nativeFile.suggestedFilename()).toBe('scrawl-release-checklist-revision-1.json');
  const nativePath = await nativeFile.path();
  if (!nativePath) throw new Error('No selected native revision download');
  const nativeText = await readFile(nativePath, 'utf8');
  const native = JSON.parse(nativeText);
  const selectedRevision = await context.request.get(`${demo.origin}/api/v1/documents/${seeded.documentId}/revisions/${seeded.revisionId}`);
  expect(selectedRevision.status()).toBe(200);
  const snapshot = await selectedRevision.json();
  expect(native.revision).toEqual({ id: snapshot.id, revisionNumber: 1, title: snapshot.title,
    createdAt: snapshot.createdAt, authorId: snapshot.authorId });
  expect(validateContent(native.content).content).toEqual(snapshot.content);
  expect(nativeText).not.toContain('Synthetic saved file export');
  expect(nativeText).not.toContain('Unsaved title excluded');
  expect(nativeText).not.toContain('Unsaved body excluded');
  expect(nativeText).not.toMatch(/"(?:password|token|session|account|email|cookie)"\s*:/i);
  await expect(title(page)).toHaveValue('Unsaved title excluded from exported files');
  await expect(body(page)).toHaveText('Unsaved body excluded from exported files.');
  await expect(save(page)).toBeEnabled();
  expect(await readDocument(context)).toEqual(saved);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
});

test('explicit publication selects immutable history, preserves dirty work and undo, and private saves never advance it', async ({ page, context, browser }) => {
  await login(page, 'administrator');
  await title(page).fill('Saved private revision two');
  await body(page).fill('Saved private body two.');
  await explicitSave(page);
  await title(page).fill('Unsaved private publication title');
  await body(page).fill('Unsaved private publication body.');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('complementary', { name: 'Revision history', exact: true });
  await history.getByRole('button', { name: 'Revision 1', exact: true }).click();
  await history.getByRole('button', { name: 'Publish revision 1', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: 'Publish revision 1?', exact: true });
  await expect(prompt).toContainText('Release checklist · revision 1');
  await expect(prompt.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  expect(await demo.database.prisma.publication.count({ where: { documentId: seeded.documentId } })).toBe(0);
  await expect(title(page)).toHaveValue('Unsaved private publication title');
  await history.getByRole('button', { name: 'Publish revision 1', exact: true }).click();
  await evidence(page, 'publication');
  const published = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/publication`);
  await prompt.getByRole('button', { name: 'Publish revision 1', exact: true }).click();
  expect((await published).status()).toBe(200);
  await expect(title(page)).toHaveValue('Unsaved private publication title');
  await expect(body(page)).toHaveText('Unsaved private publication body.');
  await expect(save(page)).toBeEnabled();
  await body(page).focus(); await page.keyboard.press('ControlOrMeta+z');
  await expect(body(page)).not.toHaveText('Unsaved private publication body.');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(body(page)).toHaveText('Unsaved private publication body.');
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
  const link = page.getByRole('link', { name: 'View public document', exact: true });
  await expect(link).toBeVisible();
  const path = await link.getAttribute('href');
  if (!path) throw new Error('No approved publication link');
  const anonymous = await browser.newContext();
  try {
    const publicPage = await anonymous.newPage();
    const privateRequests: string[] = [];
    publicPage.on('request', request => { if (/\/api\/(?:v1|auth)\//.test(new URL(request.url()).pathname)) privateRequests.push('private API'); });
    await publicPage.goto(demo.origin + path);
    await expect(publicPage.getByRole('heading', { name: 'Release checklist', exact: true })).toBeVisible();
    const publicBody = publicPage.getByRole('textbox', { name: 'Published document content', exact: true });
    await expect(publicBody).toHaveAttribute('contenteditable', 'false');
    await expect(publicBody).toContainText('Run tests before deploying.');
    const outline = publicPage.getByRole('navigation', { name: 'On this page', exact: true });
    await outline.getByRole('link', { name: 'Before you start', exact: true }).click();
    await expect(publicBody.getByRole('heading', { name: 'Before you start', exact: true })).toBeFocused();
    await expect(outline.getByRole('link', { name: 'Before you start', exact: true })).toHaveAttribute('aria-current', 'location');
    const publicSection = publicPage.url();
    expect(new URL(publicSection).hash).toMatch(/^#section-/);
    await publicPage.reload();
    await expect(publicBody.getByRole('heading', { name: 'Before you start', exact: true })).toBeFocused();
    expect(publicPage.url()).toBe(publicSection);
    await expect(publicPage.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(publicPage.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);
    await expect(publicPage.getByRole('complementary', { name: 'Workspace navigation', exact: true })).toHaveCount(0);
    expect(privateRequests).toEqual([]);
    await publicPage.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await evidence(publicPage, 'public-document');
    await explicitSave(page);
    await publicPage.reload();
    await expect(publicPage.getByRole('heading', { name: 'Release checklist', exact: true })).toBeVisible();
    await expect(publicBody).not.toContainText('Unsaved private publication body.');
    await title(page).fill('Local edits before withdrawal');
    await actions(page); await page.getByRole('button', { name: 'Withdraw publication', exact: true }).click();
    const withdrawal = page.getByRole('dialog', { name: 'Withdraw publication?', exact: true });
    const withdrawn = page.waitForResponse(response => response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/publication`);
    await withdrawal.getByRole('button', { name: 'Withdraw publication', exact: true }).click();
    expect((await withdrawn).status()).toBe(200);
    await expect(title(page)).toHaveValue('Local edits before withdrawal');
    await publicPage.reload();
    await expect(publicPage.getByRole('heading', { name: 'Published document unavailable', exact: true })).toBeVisible();
    await expect(publicBody).toHaveCount(0);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(3);
    await explicitSave(page);
    expect((await readDocument(context)).data.currentRevisionNumber).toBe(4);
  } finally { await anonymous.close(); }
});

test('stale publication returns 412, retains complete work and cannot publish or save until deliberate reconciliation', async ({ page, context }) => {
  await login(page, 'administrator');
  const baseline = await readDocument(context);
  await title(page).fill('Stale local publication title');
  await body(page).fill('Complete stale local publication body.');
  await actions(page);
  await page.getByRole('button', { name: 'Publish saved revision', exact: true }).click();
  const changed = await apiRequest(context, `/api/v1/documents/${seeded.documentId}`, {
    method: 'PATCH', headers: { Origin: demo.origin, 'If-Match': baseline.etag }, data: { title: 'Newer server title' },
  });
  expect(changed.status()).toBe(200);
  const response = page.waitForResponse(value => value.request().method() === 'POST'
    && new URL(value.url()).pathname === `/api/v1/documents/${seeded.documentId}/publication`);
  await page.getByRole('dialog', { name: 'Publish revision 1?', exact: true }).getByRole('button', { name: 'Publish revision 1', exact: true }).click();
  expect((await response).status()).toBe(412);
  await expect(page.getByRole('complementary', { name: 'Save conflict', exact: true })).toBeVisible();
  await expect(title(page)).toHaveValue('Stale local publication title');
  await expect(body(page)).toHaveText('Complete stale local publication body.');
  await expect(save(page)).toBeDisabled();
  expect(await demo.database.prisma.publication.count({ where: { documentId: seeded.documentId } })).toBe(0);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
});

test('publication controls remain administrator-only and anonymous unavailable pages never start private authentication', async ({ page, context, browser }) => {
  await login(page, 'editor');
  await actions(page);
  await expect(page.getByRole('button', { name: 'Publish saved revision', exact: true })).toHaveCount(0);
  const baseline = await readDocument(context);
  const denied = await apiRequest(context, `/api/v1/documents/${seeded.documentId}/publication`, {
    method: 'POST', headers: { Origin: demo.origin, 'If-Match': baseline.etag }, data: { revisionId: baseline.data.revision.id },
  });
  expect(denied.status()).toBe(403);
  const anonymous = await browser.newContext();
  try {
    const publicPage = await anonymous.newPage();
    const privateRequests: string[] = [];
    publicPage.on('request', request => { if (/\/api\/(?:v1|auth)\//.test(new URL(request.url()).pathname)) privateRequests.push('private API'); });
    const publicId = randomUUID(), endpoint = `${demo.origin}/api/public/publications/${publicId}`;
    let release: () => void = () => {};
    const delayed = new Promise<void>(resolve => { release = resolve; });
    await publicPage.route(endpoint, async route => {
      await delayed;
      await route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({
        type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'INTERNAL_ERROR', requestId: 'browser-public-fault',
      }) });
    }, { times: 1 });
    await publicPage.goto(`${demo.origin}/publications/${publicId}`);
    await expect(publicPage.getByRole('status')).toHaveText('Loading published document…');
    release();
    await expect(publicPage.getByRole('heading', { name: 'Could not load this document', exact: true })).toBeVisible();
    await publicPage.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(publicPage.getByRole('heading', { name: 'Published document unavailable', exact: true })).toBeVisible();
    await expect(publicPage.getByText('Release checklist', { exact: true })).toHaveCount(0);
    expect(privateRequests).toEqual([]);
  } finally { await anonymous.close(); }
});

test('public native images use the selected revision allowlist and archive/unarchive cannot revive a publication', async ({ page, context, browser }) => {
  await login(page, 'administrator');
  const baseline = await readDocument(context);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaGD4DwAChAGA+gVWHQAAAABJRU5ErkJggg==', 'base64');
  async function upload(name: string) {
    const response = await apiRequest(context, `/api/v1/documents/${seeded.documentId}/attachments`, {
      method: 'POST', headers: { Origin: demo.origin, 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, data: png,
    });
    expect(response.status()).toBe(201);
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
      || !('url' in value) || typeof value.url !== 'string') throw new Error('Invalid attachment fixture');
    return { id: value.id, url: value.url };
  }
  const approved = await upload('Synthetic approved public image.png');
  const pending = await upload('Synthetic private pending image.png');
  const changed = await apiRequest(context, `/api/v1/documents/${seeded.documentId}`, {
    method: 'PATCH', headers: { Origin: demo.origin, 'If-Match': baseline.etag }, data: { content: nativeContent([
      paragraph('public-image-text', 'Selected public image body.'),
      { id: 'public-image', type: 'image', props: { url: approved.url, name: 'Synthetic approved public image.png' }, children: [] },
    ]) },
  });
  expect(changed.status()).toBe(200);
  await page.reload(); await expect(title(page)).toHaveValue('Release checklist');
  await actions(page); await page.getByRole('button', { name: 'Publish saved revision', exact: true }).click();
  const published = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/publication`);
  await page.getByRole('dialog', { name: 'Publish revision 2?', exact: true }).getByRole('button', { name: 'Publish revision 2', exact: true }).click();
  expect((await published).status()).toBe(200);
  const link = page.getByRole('link', { name: 'View public document', exact: true });
  await expect(link).toBeVisible();
  const path = await link.getAttribute('href'), publicId = path?.split('/').at(-1);
  if (!path || !publicId) throw new Error('No approved image publication link');
  const anonymous = await browser.newContext();
  try {
    const publicPage = await anonymous.newPage();
    await publicPage.goto(demo.origin + path);
    const image = publicPage.getByRole('img', { name: 'Synthetic approved public image.png', exact: true });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', `/api/public/publications/${publicId}/attachments/${approved.id}`);
    await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth > 0)).toBe(true);
    expect((await apiRequest(anonymous, approved.url)).status()).toBe(401);
    expect((await apiRequest(anonymous, `/api/public/publications/${publicId}/attachments/${pending.id}`)).status()).toBe(404);
    await actions(page);
    const archived = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/archive`);
    await page.getByRole('button', { name: 'Archive', exact: true }).click(); expect((await archived).status()).toBe(200);
    await publicPage.reload();
    await expect(publicPage.getByRole('heading', { name: 'Published document unavailable', exact: true })).toBeVisible();
    await actions(page);
    const unarchived = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}/unarchive`);
    await page.getByRole('button', { name: 'Unarchive', exact: true }).click(); expect((await unarchived).status()).toBe(200);
    await publicPage.reload();
    await expect(publicPage.getByRole('heading', { name: 'Published document unavailable', exact: true })).toBeVisible();
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(2);
  } finally { await anonymous.close(); }
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
  expect(download.suggestedFilename()).toBe('scrawl-release-checklist-revision-3.json');
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
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('dialog', { name: 'Search documents', exact: true });
  await expect(search.getByRole('combobox', { name: 'Search accessible documents', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).not.toBeVisible();
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
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('complementary', { name: 'Revision history', exact: true });
  await history.getByRole('button', { name: 'Revision 1', exact: true }).click();
  await expect(history.getByRole('button', { name: 'Restore revision 1', exact: true })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await history.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const path = await (await download).path();
  if (!path) throw new Error('No authorized reader history download');
  const native = JSON.parse(await readFile(path, 'utf8'));
  expect(native.revision.id).toBe(seeded.revisionId);
  expect(validateContent(native.content).content).toEqual(original.data.revision.content);
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
    `/api/v1/documents/${seeded.documentId}/export?revisionId=${seeded.revisionId}`,
  ]) {
    const response = await apiRequest(context, path);
    expect(response.status()).toBe(404);
    const problem: unknown = await response.json();
    if (problem === null || typeof problem !== 'object') throw new Error('Invalid private denial response');
    expect(Object.keys(problem).sort()).toEqual(['code', 'requestId', 'status', 'title', 'type']);
    expect(response.headers().etag).toBeUndefined();
    expect(JSON.stringify(problem)).not.toContain('Release checklist');
  }
  await page.getByRole('button', { name: 'Search documents', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Search documents', exact: true });
  const scope = search.getByRole('combobox', { name: 'Search in', exact: true });
  await expect(scope.locator('option')).toHaveCount(1);
  await expect(scope).toHaveValue('');
  await search.getByRole('combobox', { name: 'Search accessible documents', exact: true }).fill('release');
  await expect(search.getByRole('heading', { name: 'No matching documents', exact: true })).toBeVisible();
  await expect(search.getByRole('listbox', { name: 'Search results', exact: true }).getByRole('option')).toHaveCount(0);
  await page.keyboard.press('Escape');
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
  const original = await readDocument(context);
  const slugRead = `**/api/v1/spaces/${seeded.spaceId}/documents/by-slug/${original.data.slug}`;
  await page.route(slugRead, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({
      type: 'about:blank', title: 'Service Unavailable', status: 503, code: 'SERVICE_UNAVAILABLE', requestId: 'browser-read-fault',
    }) });
  });
  await page.reload();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true }).first()).toBeVisible();
  await page.unroute(slugRead);
  await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
  await expect(title(page)).toHaveValue('Release checklist');
  const archived = await apiRequest(context, `/api/v1/documents/${seeded.documentId}/archive`, {
    method: 'POST', headers: { Origin: demo.origin, 'If-Match': original.etag }, data: {},
  });
  expect(archived.status()).toBe(200);
  await page.goto(`${demo.origin}/?space=${seeded.spaceId}`);
  await expect(page.getByText(/No documents/).first()).toBeVisible();
  await page.getByLabel('Show archived', { exact: true }).check();
  await expect(page.getByRole('navigation', { name: 'Documents' }).getByRole('link', { name: /Release checklist/ })).toBeVisible();
});

test('a new draft supersedes an in-flight document read without adopting its content or creating history', async ({ page, context }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fetched = 0;
  const endpoint = `**/api/v1/documents/${seeded.documentId}`;
  await page.route(endpoint, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch().catch(() => { throw new Error('The held real document read could not complete'); });
    fetched++;
    await gate;
    try { await route.fulfill({ response }); }
    catch { /* The test may have closed the page after releasing its held request. */ }
  });
  try {
    await login(page);
    await expect.poll(() => fetched).toBe(1);
    await expect(page.getByText('Loading document…', { exact: true })).toBeVisible();
    const original = await readDocument(context);
    await page.getByRole('button', { name: 'New document', exact: true }).click();
    await expect(title(page)).toHaveValue('Untitled document');
    await title(page).fill('Complete new draft while the prior document loads');
    await body(page).fill('The complete new body belongs to an unsaved document.');
    await expect(page.getByText('Loading document…', { exact: true })).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
    const staleRead = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}`);
    release();
    const staleResponse = await staleRead;
    expect(staleResponse.status()).toBe(200);
    await staleResponse.finished();
    // Let response decoding and React's next frame settle before checking that
    // the old successful request cannot install a baseline over the new draft.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(title(page)).toHaveValue('Complete new draft while the prior document loads');
    await expect(body(page)).toHaveText('The complete new body belongs to an unsaved document.');
    await expect(save(page)).toBeEnabled();
    expect(new URL(page.url()).pathname).toBe(`/spaces/${original.data.spaceSlug}`);
    expect(await readDocument(context)).toEqual(original);
    expect(await demo.database.prisma.document.count({ where: { spaceId: seeded.spaceId } })).toBe(1);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
    await page.unroute(endpoint);

    const created = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/v1/spaces/${seeded.spaceId}/documents`);
    await save(page).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const document: unknown = await response.json();
    if (!document || typeof document !== 'object' || !('id' in document) || typeof document.id !== 'string') {
      throw new Error('Explicit Save did not create a new document');
    }
    const saved = await readDocument(context, document.id);
    expect(saved.data.revision.title).toBe('Complete new draft while the prior document loads');
    expect(saved.data.revision.plainText).toBe('The complete new body belongs to an unsaved document.');
    expect(saved.data.currentRevisionNumber).toBe(1);
    await expect(save(page)).toBeDisabled();
    expect(await readDocument(context)).toEqual(original);
    expect(await demo.database.prisma.document.count({ where: { spaceId: seeded.spaceId } })).toBe(2);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  } finally { release(); await page.unroute(endpoint); }
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

test('the outline follows actual document headings with reloadable section links and retains dirty work through Back and Forward', async ({ page, context, browser }) => {
  await login(page);
  await expect(title(page)).toHaveValue('Release checklist');
  const headings = body(page).locator('h1, h2, h3, h4, h5, h6');
  const sectionNames = await headings.allTextContents();
  expect(sectionNames.length).toBeGreaterThanOrEqual(2);
  const outline = page.getByRole('navigation', { name: 'On this page', exact: true });
  await expect(outline.getByRole('link')).toHaveCount(sectionNames.length);
  for (const name of sectionNames) await expect(outline.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(outline.getByRole('link', { name: sectionNames[0]!, exact: true })).toHaveAttribute('aria-current', 'location');
  await evidence(page, 'editing');
  const baseline = await readDocument(context);
  await title(page).fill('Complete unsaved title during section navigation');
  const lastName = sectionNames.at(-1)!;
  const lastLink = outline.getByRole('link', { name: lastName, exact: true });
  await lastLink.focus();
  await page.keyboard.press('Enter');
  const heading = body(page).getByRole('heading', { name: lastName, exact: true });
  await expect(body(page)).toBeFocused();
  const headingId = await heading.evaluate(element => element.closest('[data-id]')?.getAttribute('data-id'));
  expect(headingId).toBeTruthy();
  const fragment = `#${encodeURIComponent(`section-${headingId}`)}`;
  await expect(lastLink).toHaveAttribute('href', fragment);
  await expect.poll(() => new URL(page.url()).hash).toBe(fragment);
  await expect.poll(() => selectedBlockId(page)).toBe(headingId);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const position = await heading.boundingBox();
  expect(position?.y).toBeGreaterThanOrEqual(-1);
  expect(position?.y).toBeLessThan(844);
  await outline.getByRole('link', { name: sectionNames[0]!, exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash).not.toBe(fragment);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe(fragment);
  await expect.poll(() => selectedBlockId(page)).toBe(headingId);
  await page.goForward();
  await expect.poll(() => new URL(page.url()).hash).not.toBe(fragment);
  await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true })).toHaveCount(0);
  await expect(title(page)).toHaveValue('Complete unsaved title during section navigation');
  expect(await readDocument(context)).toEqual(baseline);
  await lastLink.click();
  await expect.poll(() => new URL(page.url()).hash).toBe(fragment);
  const [opened] = await Promise.all([context.waitForEvent('page'), lastLink.click({ modifiers: ['ControlOrMeta'] })]);
  try {
    await expect(title(opened)).toHaveValue(baseline.data.revision.title);
    await expect.poll(() => new URL(opened.url()).hash).toBe(fragment);
    await expect.poll(() => selectedBlockId(opened)).toBe(headingId);
    await expect(title(page)).toHaveValue('Complete unsaved title during section navigation');
    expect(await readDocument(context)).toEqual(baseline);
  } finally { await opened.close(); }
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
  await expect.poll(() => new URL(page.url()).hash).toBe(fragment);
  await expect(outline.getByRole('link', { name: 'Updated synthetic section', exact: true })).toHaveAttribute('href', fragment);
  const sectionUrl = page.url();
  await page.reload();
  await expect(body(page).getByRole('heading', { name: 'Updated synthetic section', exact: true })).toBeVisible();
  await expect.poll(() => selectedBlockId(page)).toBe(headingId);
  await expect(save(page)).toBeDisabled();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('complementary', { name: 'Revision history', exact: true });
  await history.getByRole('button', { name: 'Revision 1', exact: true }).click();
  const historicalHeading = page.getByRole('textbox', { name: 'Revision content', exact: true }).getByRole('heading', { name: lastName, exact: true });
  await expect(historicalHeading).toBeVisible();
  expect(await historicalHeading.getAttribute('id')).not.toBe(`section-${headingId}`);
  expect(await historicalHeading.getAttribute('id')).toMatch(/^editor-/);
  expect(page.url()).toBe(sectionUrl);
  const reader = await browser.newContext(), outsider = await browser.newContext();
  try {
    const reading = await reader.newPage(); await login(reading, 'reader', sectionUrl);
    await expect(body(reading)).not.toBeEditable();
    await expect(body(reading).getByRole('heading', { name: 'Updated synthetic section', exact: true })).toBeFocused();
    expect(new URL(reading.url()).hash).toBe(fragment);
    const isolated = await outsider.newPage(); await login(isolated, 'outsider', sectionUrl);
    await expect(body(isolated)).toHaveCount(0);
    await expect(isolated.getByRole('navigation', { name: 'On this page', exact: true })).toHaveCount(0);
    await expect(isolated.getByRole('complementary', { name: 'Workspace navigation', exact: true })).not.toContainText(updated.data.revision.title);
  } finally { await reader.close(); await outsider.close(); }
  expect(await readDocument(context)).toEqual(updated);
});

test('short documents with repeated headings keep distinct section links and the chosen outline item', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await login(page);
  const content = nativeContent(['short-first', 'short-second'].flatMap(id => [
    { id, type: 'heading' as const, props: { ...textProps, level: 2 as const }, content: [text('Repeated section')], children: [] },
    paragraph(`${id}-body`, 'A short synthetic section.'),
  ]));
  const created = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { Origin: demo.origin }, data: { title: 'Short sections', content },
  });
  expect(created.status()).toBe(201);
  const document: unknown = await created.json();
  if (!document || typeof document !== 'object' || !('id' in document) || typeof document.id !== 'string') throw new Error('Missing native document identity');
  const original = await readDocument(context, document.id);
  await page.goto(`${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}`);
  await expect(title(page)).toHaveValue('Short sections');
  const links = page.getByRole('navigation', { name: 'On this page', exact: true }).getByRole('link', { name: 'Repeated section', exact: true });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', '#section-short-first');
  await expect(links.last()).toHaveAttribute('href', '#section-short-second');
  await expect(links.first()).toHaveAttribute('aria-current', 'location');
  await links.last().click();
  await expect.poll(() => selectedBlockId(page)).toBe('short-second');
  await expect(links.last()).toHaveAttribute('aria-current', 'location');
  await expect(links.first()).not.toHaveAttribute('aria-current', 'location');
  expect(new URL(page.url()).hash).toBe('#section-short-second');
  await page.reload();
  await expect.poll(() => selectedBlockId(page)).toBe('short-second');
  await expect(links.last()).toHaveAttribute('aria-current', 'location');
  await expect(body(page).getByRole('heading', { name: 'Repeated section', exact: true }).last()).toBeInViewport({ ratio: 1 });
  await expect(save(page)).toBeDisabled();
  expect(await readDocument(context, document.id)).toEqual(original);
});

test('a direct section link waits for the initial permission check before placing the editing cursor', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context);
  const heading = body(page).getByRole('heading', { name: 'Nested review notes', exact: true, includeHidden: true });
  const id = await heading.evaluate(element => element.closest('[data-id]')?.getAttribute('data-id'));
  expect(id).toBeTruthy();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/collaboration', async route => { await gate; await route.continue(); });
  try {
    await page.goto(`${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}#section-${encodeURIComponent(id!)}`);
    await page.reload();
    await expect(title(page)).toHaveValue(original.data.revision.title);
    await expect(body(page)).not.toBeEditable();
    release?.();
    await expect(body(page)).toBeEditable();
    await expect.poll(() => selectedBlockId(page)).toBe(id);
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('navigation', { name: 'On this page', exact: true }).getByRole('link', { name: 'Nested review notes', exact: true })).toHaveAttribute('aria-current', 'location');
    await expect(save(page)).toBeDisabled();
    expect(await readDocument(context)).toEqual(original);
  } finally { release?.(); }
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
  await expect(link).not.toHaveAttribute('aria-current', 'location');
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(target).toBeVisible();
  await expect(body(page)).toBeFocused();
  await expect.poll(() => selectedBlockId(page)).toBe('nested-target');
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
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(save(page)).toBeEnabled();
  await expect(body(page).getByRole('heading', { name: 'Native supplied formatting', exact: true })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(save(page)).toBeDisabled();
  await expect(body(page).getByRole('heading', { name: 'Native supplied formatting', exact: true })).toBeVisible();
  await expect(body(page).locator('strong em u s')).toHaveText('Native supplied formatting');
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
  await expect(page.getByRole('tab', { name: 'Upload', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Embed', exact: true }).click();
  const embed = page.getByPlaceholder('Enter URL', { exact: true });
  await expect(embed).toBeVisible();
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
  expect(browserErrors).toEqual([]);
});

test('supplied external link and file actions sever the opener and preserve the complete unsaved document', async ({ page, context }) => {
  const external = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Synthetic external destination</title><h1>Synthetic external destination</h1>'
      + '<script>if(window.opener){try{window.opener.location.href=window.location.origin+"/source-navigation-attempt"}catch{}}</script>');
  });
  await new Promise<void>((resolve, reject) => { external.once('error', reject); external.listen(0, '127.0.0.1', resolve); });
  const address = external.address();
  if (!address || typeof address !== 'object') throw new Error('No isolated external test origin');
  // A distinct hostname keeps Scrawl's host-only session cookie off this origin.
  const externalOrigin = `http://localhost:${address.port}`;
  try {
    await login(page);
    const original = await readDocument(context);
    await expect(page).toHaveURL(`${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}`);
    const originalURL = page.url();
    await title(page).fill('Complete unsaved title before external navigation');
    await body(page).fill('The complete unsaved linked body must remain in this tab.');
    await body(page).locator('p').first().selectText();
    await formatting(page).getByRole('button', { name: 'Create link', exact: true }).click();
    const href = page.getByPlaceholder('Edit URL', { exact: true });
    await href.fill(`${externalOrigin}/external-link`); await href.press('Enter');
    async function isolatedOpen(action: () => Promise<void>, pathname: string) {
      const draftBody = await body(page).innerText();
      const links = body(page).locator('a');
      const draftLinks = await links.evaluateAll(elements => elements.map(element => ({
        href: element.getAttribute('href'), text: element.textContent,
      })));
      expect(draftLinks.filter(link => link.href === `${externalOrigin}/external-link`).map(link => link.text).join(''))
        .toBe('The complete unsaved linked body must remain in this tab.');
      const [destination] = await Promise.all([context.waitForEvent('page'), action()]);
      try {
        await destination.waitForLoadState('domcontentloaded');
        await expect(destination).toHaveURL(externalOrigin + pathname);
        expect(await destination.evaluate(() => window.opener === null)).toBe(true);
        await expect(page).toHaveURL(originalURL);
        await expect(title(page)).toHaveValue('Complete unsaved title before external navigation');
        await expect(body(page)).toHaveText(draftBody, { useInnerText: true });
        expect(await links.evaluateAll(elements => elements.map(element => ({
          href: element.getAttribute('href'), text: element.textContent,
        })))).toEqual(draftLinks);
        await expect(save(page)).toBeEnabled();
        expect(await readDocument(context)).toEqual(original);
        expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
      } finally { await destination.close(); }
    }

    // Native link actions use a collapsed cursor. Creating a link preserves
    // the selected text, so move into it through the normal keyboard workflow.
    await body(page).focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    const openLink = page.locator('.bn-link-toolbar').getByRole('button', { name: 'Open in new tab', exact: true });
    await expect(openLink).toBeVisible();
    await isolatedOpen(() => openLink.click(), '/external-link');
    await slashBlock(page, 'file', 'File');
    await page.getByRole('tab', { name: 'Embed', exact: true }).click();
    await page.getByPlaceholder('Enter URL', { exact: true }).fill(`${externalOrigin}/external-file`);
    await page.getByRole('button', { name: 'Embed file', exact: true }).click();
    await body(page).locator('[data-content-type="file"]').click();
    await isolatedOpen(() => formatting(page).getByRole('button', { name: 'Download file', exact: true }).click(), '/external-file');
  } finally {
    external.closeAllConnections();
    await new Promise<void>((resolve, reject) => external.close(error => error ? reject(error) : resolve()));
  }
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
  const dirtyBody = await body(page).innerText();
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
  await expect(body(page)).toHaveText(dirtyBody, { useInnerText: true });
  await expect(body(page).locator('strong')).toHaveText('The full local body is different from the baseline.');
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


test('administrator space creation preserves the complete draft and saves it only on explicit Save', async ({ page, context }) => {
  await login(page, 'administrator');
  const original = await readDocument(context);
  await expect(page).toHaveURL(`${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}`);
  const originalUrl = page.url();
  const revisionCount = await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } });
  await title(page).fill('Unsaved handbook title');
  await body(page).fill('Complete unsaved handbook body.');
  await page.getByRole('button', { name: 'New space', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New space', exact: true });
  await expect(dialog.getByLabel('Space name')).toBeFocused();
  await dialog.getByLabel('Space name').fill('Product engineering');
  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: 'artifacts/screenshots/space-create-desktop.png', mask: [page.locator('.account')], maskColor: '#1a1d20' });
  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/spaces');
  await dialog.getByRole('button', { name: 'Create space', exact: true }).click();
  expect((await createdResponse).status()).toBe(201);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Created space "Product engineering".' })).toBeVisible();
  await expect(page).toHaveURL(originalUrl);
  await expect(title(page)).toHaveValue('Unsaved handbook title');
  await expect(body(page)).toContainText('Complete unsaved handbook body.');
  expect(await readDocument(context)).toEqual(original);
  expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(revisionCount);
  await save(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 2' })).toBeVisible();
  const saved = await readDocument(context);
  expect(saved.data.revision.title).toBe('Unsaved handbook title');
  expect(saved.data.currentRevisionNumber).toBe(2);
  const created = await demo.database.prisma.space.findFirstOrThrow({ where: { name: 'Product engineering' } });
  await page.getByRole('combobox', { name: 'Space', exact: true }).selectOption(created.id);
  await expect(page.getByRole('heading', { name: 'No documents yet', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await title(page).fill('Engineering start here'); await body(page).fill('A real first document in the new space.');
  await save(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 1' })).toBeVisible();
  await page.reload();
  await expect(title(page)).toHaveValue('Engineering start here');
  await expect(body(page)).toContainText('A real first document in the new space.');
});

test('space creation failure and keyboard cancellation retain document edits without automatic retry', async ({ page, context }) => {
  await login(page, 'administrator');
  const original = await readDocument(context), count = await demo.database.prisma.space.count();
  await title(page).fill('Retained after a failed space request'); await body(page).fill('Retained unsaved body.');
  let creates = 0;
  await page.route('**/api/v1/spaces', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    creates++; await route.abort('failed');
  });
  await page.getByRole('button', { name: 'New space', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New space', exact: true });
  await dialog.getByLabel('Space name').fill('   ');
  await expect(dialog.getByRole('button', { name: 'Create space', exact: true })).toBeDisabled();
  await dialog.getByLabel('Space name').fill('Network failure space');
  await dialog.getByRole('button', { name: 'Create space', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('The space could not be created.');
  await expect(dialog.getByLabel('Space name')).toHaveValue('Network failure space');
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'New space', exact: true })).toBeFocused();
  await expect(title(page)).toHaveValue('Retained after a failed space request');
  await expect(body(page)).toContainText('Retained unsaved body.');
  expect(creates).toBe(1);
  expect(await demo.database.prisma.space.count()).toBe(count);
  expect(await readDocument(context)).toEqual(original);
});

test('space creation is absent for readers and outsiders and the server rejects their direct requests', async ({ browser }) => {
  const count = await demo.database.prisma.space.count();
  for (const role of ['reader', 'outsider'] as const) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(); await login(page, role, role === 'outsider' ? demo.origin : url());
      await expect(page.getByRole('button', { name: 'New space', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Space access', exact: true })).toHaveCount(0);
      const response = await apiRequest(context, '/api/v1/spaces', {
        method: 'POST', headers: { origin: demo.origin }, data: { name: 'Unauthorized space' },
      });
      expect(response.status()).toBe(403);
      if (role === 'outsider') {
        await expect(page.getByRole('heading', { name: 'No accessible spaces' })).toBeVisible();
        await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveCount(0);
      }
    } finally { await context.close(); }
  }
  expect(await demo.database.prisma.space.count()).toBe(count);
});


test('space creation preserves a stale-save conflict without adopting a newer document ETag', async ({ page, context }) => {
  await login(page, 'administrator');
  const original = await readDocument(context);
  await title(page).fill('Local conflict title'); await body(page).fill('Complete local conflict body.');
  const concurrent = await apiRequest(context, `/api/v1/documents/${seeded.documentId}`, {
    method: 'PATCH', headers: { origin: demo.origin, 'if-match': original.etag },
    data: { title: 'Concurrent server title', content: original.data.revision.content },
  });
  expect(concurrent.status()).toBe(200);
  await save(page).click();
  await expect(page.getByRole('heading', { name: 'Save conflict', exact: true })).toBeVisible();
  const latest = await readDocument(context);
  await page.getByRole('button', { name: 'New space', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New space', exact: true });
  await dialog.getByLabel('Space name').fill('Conflict-safe workspace');
  await dialog.getByRole('button', { name: 'Create space', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(title(page)).toHaveValue('Local conflict title');
  await expect(body(page)).toContainText('Complete local conflict body.');
  await expect(save(page)).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Concurrent server title', exact: true })).toBeVisible();
  expect(await readDocument(context)).toEqual(latest);
  await page.getByRole('button', { name: 'Use my changes', exact: true }).click();
  await save(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 3' })).toBeVisible();
  expect((await readDocument(context)).data.revision.title).toBe('Local conflict title');
});

test('mobile space creation blocks dismissal and duplicate submission while its actual request is pending', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'administrator');
  const original = await readDocument(context);
  await title(page).fill('Mobile local draft'); await body(page).fill('Complete mobile draft.');
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await page.getByRole('button', { name: 'New space', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New space', exact: true });
  await dialog.getByLabel('Space name').fill('Mobile engineering');
  let release!: () => void, creates = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/spaces', async route => {
    if (route.request().method() === 'POST') { creates++; await held; }
    await route.continue();
  });
  try {
    const requested = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/spaces');
    await dialog.getByRole('button', { name: 'Create space', exact: true }).click(); await requested;
    await expect(dialog.getByRole('status')).toHaveText('Creating space…');
    await expect(dialog.getByRole('button', { name: 'Create space', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir('artifacts/screenshots', { recursive: true });
    await page.screenshot({ path: 'artifacts/screenshots/space-create-mobile.png', mask: [page.locator('.account')], maskColor: '#1a1d20' });
    release(); await expect(dialog).toBeHidden();
    await expect(title(page)).toHaveValue('Mobile local draft');
    await expect(body(page)).toContainText('Complete mobile draft.');
    expect(creates).toBe(1);
    expect(await readDocument(context)).toEqual(original);
  } finally { release(); }
});

test('space access grants, changes and revokes an existing session without saving the administrator draft', async ({ page, context, browser }) => {
  await login(page, 'administrator');
  const original = await readDocument(context);
  const baselineBody = await body(page).innerText();
  await title(page).fill('Administrator local access-management draft'); await body(page).fill('Complete unsaved access-management body.');
  await page.getByRole('button', { name: 'Space access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Space access', exact: true });
  await expect(dialog.getByLabel('Existing account email')).toBeFocused();
  await dialog.getByLabel('Existing account email').fill(demo.accountEmail('outsider'));
  await dialog.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Access updated.' })).toBeVisible();
  const outsiderContext = await browser.newContext();
  try {
    const outsider = await outsiderContext.newPage(); await login(outsider, 'outsider');
    await expect(title(outsider)).toHaveValue(original.data.revision.title);
    await expect(title(outsider)).toHaveAttribute('readonly', ''); await expect(save(outsider)).toHaveCount(0);
    const row = dialog.locator('li').filter({ hasText: demo.accountEmail('outsider') });
    await row.getByRole('combobox').selectOption('editor'); await row.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(row.getByRole('combobox')).toHaveValue('editor');
    await outsider.reload(); await expect(body(outsider)).toBeEditable();
    await title(outsider).fill('Retained after membership revocation'); await body(outsider).fill('Complete revoked local draft.');
    await row.getByRole('button', { name: 'Remove', exact: true }).click();
    await dialog.getByRole('button', { name: 'Keep access', exact: true }).click();
    expect((await apiRequest(outsiderContext, `/api/v1/documents/${seeded.documentId}`)).status()).toBe(200);
    await row.getByRole('button', { name: 'Remove', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect((await apiRequest(outsiderContext, `/api/v1/documents/${seeded.documentId}`)).status()).toBe(404);
    await save(outsider).click();
    await expect(title(outsider)).toHaveValue('Retained after membership revocation');
    await expect(title(outsider)).toHaveAttribute('readonly', '');
    await expect(body(outsider)).toContainText('Complete revoked local draft.');
    await expect(outsider.getByRole('navigation', { name: 'Documents', exact: true })).toHaveCount(0);
    await cannotSave(outsider);
    expect(await readDocument(context)).toEqual(original);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(title(page)).toHaveValue('Administrator local access-management draft');
    await expect(body(page)).toContainText('Complete unsaved access-management body.');
    await body(page).press('ControlOrMeta+z'); await expect(body(page)).toHaveText(baselineBody, { useInnerText: true });
    await body(page).press('ControlOrMeta+Shift+z'); await expect(body(page)).toContainText('Complete unsaved access-management body.');
    await save(page).click(); await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 2' })).toBeVisible();
    expect((await readDocument(context)).data.currentRevisionNumber).toBe(2);
  } finally { await outsiderContext.close(); }
});

test('space access requires deliberate reload and resubmission after concurrent membership changes', async ({ page, context }) => {
  await login(page, 'administrator');
  const original = await readDocument(context);
  await title(page).fill('Local draft during access conflict'); await body(page).fill('Complete body during access conflict.');
  await page.getByRole('button', { name: 'Space access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Space access', exact: true });
  await expect(dialog.getByRole('button', { name: 'Reload access', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: `Access for ${demo.accountEmail('reader')}` })).toBeVisible();
  const space = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}`);
  const concurrent = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/members/${demo.accountId('editor')}`, {
    method: 'PUT', headers: { origin: demo.origin, 'if-match': space.headers().etag! }, data: { role: 'reader' },
  });
  expect(concurrent.status()).toBe(200);
  const attempted: Array<string | undefined> = [];
  page.on('request', request => { if (request.method() === 'PUT') attempted.push(request.headers()['if-match']); });
  await dialog.getByLabel('Existing account email').fill(demo.accountEmail('reader'));
  await dialog.getByRole('combobox', { name: 'Access', exact: true }).selectOption('editor');
  await dialog.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Access changed elsewhere.');
  await expect(dialog.getByRole('button', { name: 'Grant access', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Existing account email')).toHaveValue(demo.accountEmail('reader'));
  expect(attempted).toEqual([space.headers().etag]);
  expect(await readDocument(context)).toEqual(original);
  await dialog.getByRole('button', { name: 'Reload access', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Grant access', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Access updated.' })).toBeVisible();
  expect(attempted).toEqual([space.headers().etag, concurrent.headers().etag]);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(title(page)).toHaveValue('Local draft during access conflict'); await expect(body(page)).toContainText('Complete body during access conflict.');
  expect(await readDocument(context)).toEqual(original);
});

test('space access failures retain requested changes and never provision accounts or retry writes', async ({ page, context }) => {
  await login(page, 'administrator');
  const original = await readDocument(context), users = await demo.database.prisma.user.count();
  await title(page).fill('Draft retained through access failure'); await body(page).fill('Retained document body.');
  await page.getByRole('button', { name: 'Space access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Space access', exact: true });
  await dialog.getByLabel('Existing account email').fill('not-provisioned@example.test');
  await expect(dialog.getByRole('button', { name: 'Grant access', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('No existing account uses that email.');
  expect(await demo.database.prisma.user.count()).toBe(users);
  await dialog.getByLabel('Existing account email').fill(demo.accountEmail('administrator'));
  await dialog.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Administrators already have access' })).toBeVisible();
  let writes = 0;
  await page.route(`**/api/v1/spaces/${seeded.spaceId}/members/*`, async route => {
    if (route.request().method() === 'PUT') { writes++; await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
    else await route.continue();
  });
  await dialog.getByLabel('Existing account email').fill(demo.accountEmail('reader'));
  await dialog.getByRole('combobox', { name: 'Access', exact: true }).selectOption('editor');
  await dialog.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('The access change could not be confirmed.');
  await expect(dialog.getByRole('button', { name: 'Grant access', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Existing account email')).toHaveValue(demo.accountEmail('reader'));
  await expect(dialog.getByRole('combobox', { name: 'Access', exact: true })).toHaveValue('editor');
  expect(writes).toBe(1);
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Space access', exact: true })).toBeFocused();
  await expect(title(page)).toHaveValue('Draft retained through access failure'); await expect(body(page)).toContainText('Retained document body.');
  expect(await readDocument(context)).toEqual(original);
});

test('space access loss rechecks permissions and retains the entire local draft without unrelated navigation', async ({ page, context }) => {
  await login(page, 'administrator');
  const original = await readDocument(context);
  await title(page).fill('Full local title after administrator downgrade'); await body(page).fill('Full local body after administrator downgrade.');
  await page.getByRole('button', { name: 'Space access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Space access', exact: true });
  await dialog.getByLabel('Existing account email').fill(demo.accountEmail('reader'));
  await expect(dialog.getByRole('button', { name: 'Grant access', exact: true })).toBeEnabled();
  await demo.database.prisma.user.update({ where: { id: demo.accountId('administrator') }, data: { role: 'member' } });
  try {
    await dialog.getByRole('button', { name: 'Grant access', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(title(page)).toHaveValue('Full local title after administrator downgrade');
    await expect(title(page)).toHaveAttribute('readonly', ''); await expect(body(page)).toContainText('Full local body after administrator downgrade.');
    await expect(page.getByRole('navigation', { name: 'Documents', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Space access', exact: true })).toHaveCount(0); await cannotSave(page);
    expect(await demo.database.prisma.documentRevision.count({ where: { documentId: seeded.documentId } })).toBe(1);
  } finally { await demo.database.prisma.user.update({ where: { id: demo.accountId('administrator') }, data: { role: 'administrator' } }); }
  expect(await readDocument(context)).toEqual(original);
});

test('mobile space access has keyboard focus, loading feedback and pending-write dismissal guards', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, 'administrator');
  const original = await readDocument(context);
  let releaseRead!: () => void, releaseWrite!: () => void;
  const readHeld = new Promise<void>(resolve => { releaseRead = resolve; }), writeHeld = new Promise<void>(resolve => { releaseWrite = resolve; });
  await page.route(`**/api/v1/spaces/${seeded.spaceId}/members**`, async route => {
    if (route.request().method() === 'GET') await readHeld;
    if (route.request().method() === 'PUT') await writeHeld;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Space access', exact: true }).press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Space access', exact: true });
    await expect(dialog.getByRole('status')).toHaveText('Loading members…');
    await expect(dialog.getByLabel('Existing account email')).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Grant access', exact: true })).toBeDisabled();
    releaseRead();
    await dialog.getByLabel('Existing account email').fill(demo.accountEmail('reader'));
    await expect(dialog.getByRole('button', { name: 'Grant access', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Grant access', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'Updating access…' })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir('artifacts/screenshots', { recursive: true });
    await page.screenshot({ path: 'artifacts/screenshots/space-access-mobile.png', mask: [page.locator('.account')], maskColor: '#1b1e20' });
    releaseWrite(); await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    expect(await readDocument(context)).toEqual(original);
  } finally { releaseRead(); releaseWrite(); }
});

test('space access shows a real empty grant list and read failures cannot enable mutations', async ({ page, context }) => {
  await login(page, 'administrator');
  const response = await apiRequest(context, '/api/v1/spaces', { method: 'POST', headers: { origin: demo.origin }, data: { name: 'Unshared handbook' } });
  expect(response.status()).toBe(201);
  const created: unknown = await response.json();
  if (!created || typeof created !== 'object' || !('slug' in created) || typeof created.slug !== 'string'
    || !('id' in created) || typeof created.id !== 'string') throw new Error('Created space identity is missing');
  await page.goto(`${demo.origin}/spaces/${created.slug}`);
  await expect(page.getByRole('heading', { name: 'No documents yet', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Space access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Space access', exact: true });
  await expect(dialog.getByText('No member grants. Only administrators can access this space.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await page.route(`**/api/v1/spaces/${created.id}/members**`, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.getByRole('button', { name: 'Space access', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('The member list could not be loaded.');
  await dialog.getByLabel('Existing account email').fill(demo.accountEmail('reader'));
  await expect(dialog.getByRole('button', { name: 'Grant access', exact: true })).toBeDisabled();
  expect(await demo.database.prisma.spaceMembership.count({ where: { spaceId: created.id } })).toBe(0);
  await page.unroute(`**/api/v1/spaces/${created.id}/members**`);
  await dialog.getByRole('button', { name: 'Reload access', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Grant access', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Existing account email')).toHaveValue(demo.accountEmail('reader'));
});

test('save shortcut persists complete native edits and a clean shortcut creates no revision', async ({ page, context }) => {
  await login(page); await expect(save(page)).toBeDisabled();
  let writes = 0;
  page.on('request', request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/v1/documents/${seeded.documentId}`) writes++; });
  await expect(save(page)).toHaveAttribute('aria-keyshortcuts', 'Control+s Meta+s');
  await title(page).fill('Saved with the document shortcut');
  await body(page).fill('Complete native keyboard save.');
  await body(page).press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 2' })).toBeVisible();
  expect(writes).toBe(1);
  await body(page).press('ControlOrMeta+s');
  expect(writes).toBe(1); expect((await readDocument(context)).data.currentRevisionNumber).toBe(2);
  await page.reload(); await expect(title(page)).toHaveValue('Saved with the document shortcut');
  await expect(body(page)).toHaveText('Complete native keyboard save.');
  await assertNoBrowserPersistence(page);
});

test('save shortcut cannot duplicate a pending write and failed work requires deliberate retry', async ({ page, context }) => {
  await login(page); await title(page).fill('Keyboard work retained after failure'); await body(page).fill('Full unsaved body remains local.');
  let release!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on('request', request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/v1/documents/${seeded.documentId}`) writes++; });
  const endpoint = `**/api/v1/documents/${seeded.documentId}`;
  await page.route(endpoint, async route => { if (route.request().method() !== 'PATCH') { await route.continue(); return; } await gate; await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); });
  try {
    await body(page).press('ControlOrMeta+s'); await expect(save(page)).toBeDisabled();
    await expect.poll(() => writes).toBe(1);
    await body(page).press('ControlOrMeta+s'); expect(writes).toBe(1);
  } finally { release(); }
  await expect(page.getByRole('alert').filter({ hasText: 'The request failed.' })).toBeVisible();
  await expect(title(page)).toHaveValue('Keyboard work retained after failure'); await expect(body(page)).toHaveText('Full unsaved body remains local.');
  expect((await readDocument(context)).data.currentRevisionNumber).toBe(1);
  await page.unroute(endpoint); await body(page).press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 2' })).toBeVisible(); expect(writes).toBe(2);
});

test('save shortcut retains stale work and requires deliberate reconciliation before another write', async ({ page, context }) => {
  await login(page); await expect(save(page)).toBeDisabled(); const original = await readDocument(context);
  await title(page).fill('Complete local shortcut draft'); await body(page).fill('Complete retained native body.');
  const localBody = await body(page).innerText();
  const remote = await apiRequest(context, `/api/v1/documents/${seeded.documentId}`, { method: 'PATCH', headers: { origin: demo.origin, 'if-match': original.etag }, data: { title: 'New remote saved title' } });
  expect(remote.status()).toBe(200);
  let writes = 0; page.on('request', request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/v1/documents/${seeded.documentId}`) writes++; });
  const rejected = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/documents/${seeded.documentId}`);
  await body(page).press('ControlOrMeta+s'); expect((await rejected).status()).toBe(412);
  await expect(page.getByRole('heading', { name: 'Save conflict', exact: true })).toBeVisible();
  await expect(title(page)).toHaveValue('Complete local shortcut draft'); await expect(body(page)).toHaveText(localBody, { useInnerText: true });
  await body(page).press('ControlOrMeta+s'); expect(writes).toBe(1);
  expect((await readDocument(context)).data.currentRevisionNumber).toBe(2);
  await page.getByRole('button', { name: 'Use my changes', exact: true }).click();
  expect(writes).toBe(1); await body(page).press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 3' })).toBeVisible(); expect(writes).toBe(2);
});

test('save shortcut does not write from a space dialog or a reader session', async ({ page, context, browser }) => {
  await login(page, 'administrator'); await title(page).fill('Draft under a space dialog');
  let writes = 0; page.on('request', request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/v1/documents/${seeded.documentId}`) writes++; });
  await page.getByRole('button', { name: 'Space access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Space access', exact: true });
  await dialog.getByLabel('Existing account email').fill('synthetic@example.test');
  await dialog.getByLabel('Existing account email').press('ControlOrMeta+s');
  await expect(dialog).toBeVisible(); expect(writes).toBe(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click(); await expect(title(page)).toHaveValue('Draft under a space dialog');
  expect((await readDocument(context)).data.currentRevisionNumber).toBe(1);
  const reader = await browser.newContext();
  try {
    const readOnly = await reader.newPage(); await login(readOnly, 'reader'); await expect(body(readOnly)).toHaveAttribute('aria-readonly', 'true');
    let readerWrites = 0; readOnly.on('request', request => { if (['PATCH', 'POST'].includes(request.method()) && new URL(request.url()).pathname.includes('/documents/')) readerWrites++; });
    await body(readOnly).press('ControlOrMeta+s'); expect(readerWrites).toBe(0); await expect(save(readOnly)).toHaveCount(0);
    expect((await readDocument(context)).data.currentRevisionNumber).toBe(1);
  } finally { await reader.close(); }
});

test('an authorized structural move preserves readable links and forces deliberate reconciliation of an open draft', async ({ page, context, browser }) => {
  await login(page); const original = await readDocument(context);
  expect(original.data.parentDocumentId).toBeNull();
  const parentResponse = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { origin: demo.origin }, data: { title: 'Organization API parent', content: original.data.revision.content },
  });
  expect(parentResponse.status()).toBe(201);
  const parent: unknown = await parentResponse.json();
  if (!parent || typeof parent !== 'object' || !('id' in parent) || typeof parent.id !== 'string') throw new Error('Missing parent identity');
  await title(page).fill('Complete local title after structural move'); await body(page).fill('Complete unsaved body after structural move.');
  const moved = await apiRequest(context, `/api/v1/documents/${seeded.documentId}/move`, {
    method: 'POST', headers: { origin: demo.origin, 'if-match': original.etag }, data: { parentDocumentId: parent.id },
  });
  expect(moved.status()).toBe(200);
  const latest = await readDocument(context);
  expect(latest.data.parentDocumentId).toBe(parent.id); expect(latest.data.currentRevisionNumber).toBe(1);
  expect(latest.data.revision).toEqual(original.data.revision); expect(latest.data.slug).toBe(original.data.slug);
  await save(page).click(); await expect(page.getByRole('heading', { name: 'Save conflict', exact: true })).toBeVisible();
  await expect(title(page)).toHaveValue('Complete local title after structural move'); await expect(body(page)).toHaveText('Complete unsaved body after structural move.');
  await page.getByRole('button', { name: 'Use my changes', exact: true }).click(); await save(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 2' })).toBeVisible();
  const saved = await readDocument(context); expect(saved.data.parentDocumentId).toBe(parent.id); expect(saved.data.currentRevisionNumber).toBe(2);
  await page.reload(); await expect(title(page)).toHaveValue(saved.data.revision.title);
  await expect(body(page)).toHaveText('Complete unsaved body after structural move.');
  await expect(page).toHaveURL(`${demo.origin}/spaces/${original.data.spaceSlug}/documents/${original.data.slug}`);
  const reader = await browser.newContext(), outsider = await browser.newContext();
  try {
    const readOnly = await reader.newPage(); await login(readOnly, 'reader', page.url());
    await expect(title(readOnly)).toHaveValue(saved.data.revision.title); await expect(body(readOnly)).toHaveAttribute('aria-readonly', 'true'); await expect(save(readOnly)).toHaveCount(0);
    const denied = await outsider.newPage(); await login(denied, 'outsider', page.url());
    await expect(denied.getByText(/No accessible spaces|Access to this document is unavailable/).first()).toBeVisible();
    await expect(denied.getByRole('navigation', { name: 'Documents', exact: true })).toHaveCount(0); await expect(title(denied)).toHaveCount(0); await expect(body(denied)).toHaveCount(0);
    const response = await apiRequest(outsider, `/api/v1/documents/${seeded.documentId}`); expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain('parentDocumentId'); expect(await response.text()).not.toContain('Organization API parent');
  } finally { await reader.close(); await outsider.close(); }
});

test('organization creates a native child with guarded drafts, breadcrumbs and a persistent nested location', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context);
  await title(page).fill('Retained parent draft');
  await page.getByLabel('Document actions').click();
  await page.getByRole('button', { name: 'New child document', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(title(page)).toHaveValue('Retained parent draft');
  await page.getByLabel('Document actions').click();
  await page.getByRole('button', { name: 'New child document', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByLabel('New document location')).toHaveValue(original.data.id);
  await title(page).fill('Nested onboarding guide');
  await body(page).fill('Native child body survives its first explicit save.');
  await save(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 1' })).toBeVisible();
  const current = page.url();
  const childLink = page.getByRole('navigation', { name: 'Documents', exact: true }).getByRole('link', { name: 'Nested onboarding guide', exact: true });
  await expect(childLink).toBeVisible();
  const response = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`);
  expect(response.status()).toBe(200);
  const children = await response.json() as operations['listDocuments']['responses'][200]['content']['application/json'];
  const child = children.items.find(item => item.title === 'Nested onboarding guide');
  if (!child) throw new Error('The saved child is absent from the authorized list');
  expect((await readDocument(context, child.id)).data.parentDocumentId).toBe(original.data.id);
  await expect(page.getByRole('navigation', { name: 'Document path' }).getByRole('link', { name: original.data.revision.title, exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(current);
  await expect(body(page)).toContainText('Native child body survives');
  await expect(childLink).toBeVisible();
  expect((await readDocument(context)).data.revision).toEqual(original.data.revision);
});

test('organization moves use the saved ETag without creating history or changing URLs and remain keyboard accessible', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context), parent = await navigationDocument(context);
  await page.reload();
  await expect(title(page)).toHaveValue(original.data.revision.title);
  const location = page.url();
  await page.getByLabel('Document actions').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Move document', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move document', exact: true });
  await expect(dialog.getByRole('option', { name: original.data.revision.title, exact: true })).toHaveCount(0);
  await dialog.getByLabel('Parent document').selectOption(parent.id);
  await dialog.getByRole('button', { name: 'Move document', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Document moved.', { exact: true })).toBeVisible();
  const moved = await readDocument(context);
  expect(moved.data.parentDocumentId).toBe(parent.id);
  expect(moved.data.revision).toEqual(original.data.revision);
  expect(moved.data.currentRevisionNumber).toBe(original.data.currentRevisionNumber);
  expect(moved.etag).not.toBe(original.etag);
  await expect(page).toHaveURL(location);
  await expect(page.getByRole('navigation', { name: 'Document path' }).getByRole('link', { name: 'Another handbook', exact: true })).toBeVisible();
  await expect(page.getByLabel('Document actions')).toBeFocused();
  await evidence(page, 'organization');
  const disclosure = page.getByRole('button', { name: 'Child documents of Another handbook', exact: true });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await disclosure.focus(); await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Documents', exact: true }).getByRole('link', { name: original.data.revision.title, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('organization stale moves retain the complete local snapshot and require deliberate reconciliation', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context), parent = await navigationDocument(context);
  await page.reload();
  await expect(title(page)).toHaveValue(original.data.revision.title);
  const localBody = await body(page).innerText();
  const changed = await apiRequest(context, `/api/v1/documents/${original.data.id}`, {
    method: 'PATCH', headers: { origin: demo.origin, 'If-Match': original.etag },
    data: { title: 'Remote saved heading', content: original.data.revision.content },
  });
  expect(changed.status()).toBe(200);
  const latest = await readDocument(context);
  await page.getByLabel('Document actions').click();
  await page.getByRole('button', { name: 'Move document', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move document', exact: true });
  await dialog.getByLabel('Parent document').selectOption(parent.id);
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/move'));
  await dialog.getByRole('button', { name: 'Move document', exact: true }).click();
  expect((await rejected).status()).toBe(412);
  await expect(page.getByRole('heading', { name: 'Save conflict', exact: true })).toBeVisible();
  await expect(title(page)).toHaveValue(original.data.revision.title);
  await expect.poll(() => body(page).innerText()).toBe(localBody);
  await expect(page.getByText('Remote saved heading', { exact: true })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect((await readDocument(context)).data).toEqual(latest.data);
  await page.getByRole('button', { name: 'Use server version', exact: true }).click();
  await expect(title(page)).toHaveValue('Remote saved heading');
  await expect(page.getByRole('heading', { name: 'Save conflict', exact: true })).toHaveCount(0);
  expect((await readDocument(context)).data).toEqual(latest.data);
});

test('organization an uncertain move never retries and requires comparison before another mutation', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context), parent = await navigationDocument(context);
  await page.reload();
  await expect(title(page)).toHaveValue(original.data.revision.title);
  let attempts = 0;
  await page.route(`**/api/v1/documents/${original.data.id}/move`, async route => {
    attempts++; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'INJECTED_TEMPORARY_FAILURE' }) });
  });
  await page.getByLabel('Document actions').click();
  await page.getByRole('button', { name: 'Move document', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move document', exact: true });
  await dialog.getByLabel('Parent document').selectOption(parent.id);
  await dialog.getByRole('button', { name: 'Move document', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('The move could not be confirmed');
  await expect(dialog.getByRole('button', { name: 'Move document', exact: true })).toBeDisabled();
  await expect(page.locator('#title')).toHaveValue(original.data.revision.title);
  expect(attempts).toBe(1);
  expect((await readDocument(context)).data).toEqual(original.data);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Document actions').click();
  await page.getByRole('button', { name: 'Move document', exact: true }).click();
  await expect(dialog.getByLabel('Parent document')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Move document', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Compare latest document', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save conflict', exact: true })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect(attempts).toBe(1);
  expect((await readDocument(context)).data).toEqual(original.data);
});

test('organization parent archive is explicit and readers and outsiders cannot acquire structural controls', async ({ page, context, browser }) => {
  await login(page);
  const parent = await readDocument(context);
  const created = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { origin: demo.origin },
    data: { title: 'Access controlled child', content: parent.data.revision.content, parentDocumentId: parent.data.id },
  });
  expect(created.status()).toBe(201);
  const child = await created.json() as Document;
  await page.reload();
  await expect(title(page)).toHaveValue(parent.data.revision.title);
  await page.getByLabel('Document actions').click();
  const archive = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/archive'));
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  expect((await archive).status()).toBe(409);
  await expect(page.getByRole('alert')).toContainText('Move or archive child documents');
  await expect(page.locator('.documentbar').getByRole('status')).toHaveText('Request failed · saved version retained');
  expect((await readDocument(context)).data).toEqual(parent.data);
  const readerContext = await browser.newContext(), outsiderContext = await browser.newContext();
  try {
    const reader = await readerContext.newPage();
    await login(reader, 'reader', `${demo.origin}/spaces/${child.spaceSlug}/documents/${child.slug}`);
    await expect(title(reader)).toHaveValue(child.revision.title);
    await expect(reader.getByRole('navigation', { name: 'Document path' }).getByRole('link', { name: parent.data.revision.title, exact: true })).toBeVisible();
    await reader.getByLabel('Document actions').click();
    await expect(reader.getByRole('button', { name: 'Move document', exact: true })).toHaveCount(0);
    await expect(reader.getByRole('button', { name: 'New child document', exact: true })).toHaveCount(0);
    const denied = await apiRequest(readerContext, `/api/v1/documents/${child.id}/move`, {
      method: 'POST', headers: { origin: demo.origin, 'If-Match': created.headers().etag! }, data: { parentDocumentId: null },
    });
    expect(denied.status()).toBe(404);
    const outsider = await outsiderContext.newPage();
    await login(outsider, 'outsider', `${demo.origin}/spaces/${child.spaceSlug}/documents/${child.slug}`);
    await expect(outsider.getByRole('navigation', { name: 'Documents', exact: true })).toHaveCount(0);
    await expect(outsider.getByRole('navigation', { name: 'Document path' })).toHaveCount(0);
    await expect(outsider.getByText('Access controlled child', { exact: true })).toHaveCount(0);
    expect((await readDocument(context, child.id)).data).toEqual(child);
  } finally { await readerContext.close(); await outsiderContext.close(); }
});

test('organization assembles all authorized cursor pages before locating a child under its last-page parent', async ({ page, context }) => {
  test.setTimeout(120_000); // Deliberately crosses the real 100-document API page boundary.
  await login(page);
  const original = await readDocument(context);
  const created: Document[] = [];
  for (let offset = 0; offset < 101; offset += 4) {
    const batch = await Promise.all(Array.from({ length: Math.min(4, 101 - offset) }, async (_, index) => {
      const response = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
        method: 'POST', headers: { origin: demo.origin },
        data: { title: `Pagination document ${offset + index + 1}`, content: original.data.revision.content },
      });
      expect(response.status()).toBe(201);
      return await response.json() as Document;
    }));
    created.push(...batch);
  }
  const ordered = [...created, original.data].sort((a, b) => a.id.localeCompare(b.id));
  const child = ordered[0]!, parent = ordered.at(-1)!;
  const before = await readDocument(context, child.id);
  const moved = await apiRequest(context, `/api/v1/documents/${child.id}/move`, {
    method: 'POST', headers: { origin: demo.origin, 'If-Match': before.etag }, data: { parentDocumentId: parent.id },
  });
  expect(moved.status()).toBe(200);
  const firstPage = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents?limit=100&includeArchived=true`);
  expect(firstPage.status()).toBe(200);
  const first = await firstPage.json() as operations['listDocuments']['responses'][200]['content']['application/json'];
  expect(first.items).toHaveLength(100);
  expect(first.items.some(item => item.id === parent.id)).toBe(false);
  expect(first.nextCursor).toBeTruthy();
  await page.goto(`${demo.origin}/spaces/${child.spaceSlug}/documents/${child.slug}`);
  await expect(title(page)).toHaveValue(child.revision.title);
  await expect(page.getByRole('navigation', { name: 'Document path' }).getByRole('link', { name: parent.revision.title, exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Documents', exact: true });
  await expect(navigation.getByRole('button', { name: `Child documents of ${parent.revision.title}`, exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation.getByRole('link', { name: child.revision.title, exact: true })).toBeVisible();
  expect((await readDocument(context, child.id)).data.revision).toEqual(before.data.revision);
  await title(page).fill('Complete pagination draft remains local');
  await page.getByLabel('Show archived', { exact: true }).check();
  await expect(title(page)).toHaveValue('Complete pagination draft remains local');
  await expect(navigation.getByRole('link', { name: parent.revision.title, exact: true })).toBeVisible();
  expect((await readDocument(context, child.id)).data.revision).toEqual(before.data.revision);
});

test('organization a 32-level branch stays usable on mobile and cannot offer an impossible child location', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context);
  let leaf = original.data;
  for (let level = 2; level <= 32; level++) {
    const response = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
      method: 'POST', headers: { origin: demo.origin },
      data: { title: `Level ${level} handbook appendix`, content: original.data.revision.content, parentDocumentId: leaf.id },
    });
    expect(response.status()).toBe(201);
    leaf = await response.json() as Document;
  }
  const before = await readDocument(context, leaf.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${demo.origin}/spaces/${leaf.spaceSlug}/documents/${leaf.slug}`);
  await expect(title(page)).toHaveValue(leaf.revision.title);
  const path = page.getByRole('navigation', { name: 'Document path', exact: true });
  await expect(path.locator('a')).toHaveCount(32);
  await expect(path.getByRole('link')).toHaveCount(3);
  const earlier = path.getByLabel('Earlier parent documents');
  await earlier.focus(); await page.keyboard.press('Enter');
  await expect(path.getByRole('link', { name: original.data.revision.title, exact: true })).toBeVisible();
  await earlier.focus(); await page.keyboard.press('Enter');
  await expect(path.getByRole('link')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Document actions').click();
  const childAction = page.getByRole('button', { name: 'New child document', exact: true });
  await expect(childAction).toBeDisabled();
  await expect(childAction).toHaveAccessibleDescription('Nesting limit reached (32 levels).');
  const menuBounds = await page.locator('.doc-menu .menu-items').boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(390);
  await evidence(page, 'organization-depth');
  const rejected = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { origin: demo.origin },
    data: { title: 'Impossible level 33', content: original.data.revision.content, parentDocumentId: leaf.id },
  });
  expect(rejected.status()).toBe(409);
  expect((await readDocument(context, leaf.id)).data).toEqual(before.data);
  await page.getByLabel('Document actions').click();
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: 'Documents', exact: true });
  const current = navigation.getByRole('link', { name: leaf.revision.title, exact: true });
  await current.scrollIntoViewIfNeeded();
  await expect(current).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const parentToggle = navigation.getByRole('button', { name: 'Child documents of Level 31 handbook appendix', exact: true });
  await parentToggle.focus(); await page.keyboard.press('Enter');
  await expect(current).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(current).toBeVisible();
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await expect(page.getByLabel('New document location')).toHaveValue('');
  await title(page).fill('New root outside the deep branch');
  await body(page).fill('A new root remains available after the nesting limit is reached.');
  await save(page).click();
  await expect(page.locator('.documentbar').getByRole('status')).toHaveText('Saved · revision 1');
  expect((await readDocument(context, leaf.id)).data).toEqual(before.data);
});

test('organization opening a space selects its first active alphabetical root instead of a UUID-sorted child', async ({ page, context }) => {
  await login(page);
  const original = await readDocument(context), other = await navigationDocument(context);
  const ordered = [original.data, other].sort((a, b) => a.id.localeCompare(b.id));
  const rootSnapshots: Document[] = [];
  for (const [index, document] of ordered.entries()) {
    const current = await readDocument(context, document.id);
    const renamed = await apiRequest(context, `/api/v1/documents/${document.id}`, {
      method: 'PATCH', headers: { origin: demo.origin, 'If-Match': current.etag },
      data: { title: index === 0 ? 'Z root' : 'A root', content: current.data.revision.content },
    });
    expect(renamed.status()).toBe(200);
    rootSnapshots.push(await renamed.json() as Document);
  }
  const first = rootSnapshots.find(item => item.revision.title === 'A root')!;
  const child = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`, {
    method: 'POST', headers: { origin: demo.origin },
    data: { title: '0 child before root titles', content: first.revision.content, parentDocumentId: first.id },
  });
  expect(child.status()).toBe(201);
  const listed = await apiRequest(context, `/api/v1/spaces/${seeded.spaceId}/documents`);
  expect(listed.status()).toBe(200);
  const documents = await listed.json() as operations['listDocuments']['responses'][200]['content']['application/json'];
  expect(documents.items[0]?.title).not.toBe('A root');
  await page.goto(`${demo.origin}/spaces/${first.spaceSlug}`);
  await expect(title(page)).toHaveValue('A root');
  await expect(page).toHaveURL(`${demo.origin}/spaces/${first.spaceSlug}/documents/${first.slug}`);
  expect((await readDocument(context, first.id)).data).toEqual(first);
  await page.reload();
  await expect(title(page)).toHaveValue('A root');
  expect((await readDocument(context, first.id)).data).toEqual(first);
});
