// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium, expect, type APIResponse, type Page } from '@playwright/test';
import { readDemoConfig, readDemoCredentials, readPrivateDemoEnvironment, readPrivateDemoFile, type DemoRole } from './demo-config.js';
import { privateDemoOrigin } from './demo-server.js';
import { validateContent } from '../src/shared/content.js';

/** Opt-in acceptance check of the retained synthetic demo, without setup/reset. */
async function main() {
  const { values } = parseArgs({ options: { origin: { type: 'string' } }, allowPositionals: false });
  const { identity } = readDemoConfig(await readPrivateDemoEnvironment());
  const origin = values.origin === undefined ? identity.origin : privateDemoOrigin(['--origin', values.origin])!;
  const credentials = await readDemoCredentials();
  const manifest: unknown = JSON.parse(await readPrivateDemoFile('artifacts/demo/workspace.json'));
  assert(manifest && typeof manifest === 'object' && 'spaceId' in manifest && typeof manifest.spaceId === 'string'
    && 'startDocumentId' in manifest && typeof manifest.startDocumentId === 'string');
  const location = `${origin}/?space=${manifest.spaceId}&document=${manifest.startDocumentId}`;
  const evidenceDirectory = 'artifacts/running-evidence';
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch();
  let stage = 'startup';
  const failures: string[] = [];
  try {
    for (const role of ['administrator', 'reader', 'outsider'] as const) {
      stage = `${role} login page load`;
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.on('pageerror', () => failures.push('Browser execution failed'));
      try {
        await page.goto(location);
        await login(page, role);
        if (role !== 'administrator') {
          stage = `${role} space-access isolation`;
          await expect(page.getByRole('button', { name: 'Space access', exact: true })).toHaveCount(0);
          assert.equal((await context.request.get(`${origin}/api/v1/spaces/${manifest.spaceId}/members`)).status(), 404);
          assert.equal((await context.request.post(`${origin}/api/v1/users/lookup`, { headers: { origin }, data: { email: credentials.accounts.reader.email } })).status(), 404);
        }
        if (role === 'outsider') {
          stage = 'outsider isolation';
          await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toHaveCount(0);
          await expect(page.getByRole('textbox', { name: 'Document body', exact: true })).toHaveCount(0);
          assert(!await page.getByText('Scrawl field guide', { exact: true }).count());
          const denied: APIResponse = await context.request.get(`${origin}/api/v1/documents/${manifest.startDocumentId}`);
          assert.equal(denied.status(), 404);
          await expect(page.getByRole('button', { name: 'New space', exact: true })).toHaveCount(0);
        } else {
          stage = `${role} native saved content and private image`;
          const title = page.getByRole('textbox', { name: 'Document title', exact: true });
          const body = page.getByRole('textbox', { name: 'Document body', exact: true });
          await expect(title).toHaveValue('Start here');
          stage = `${role} readable link and reload`;
          const routeResponse: APIResponse = await context.request.get(`${origin}/api/v1/documents/${manifest.startDocumentId}`);
          assert.equal(routeResponse.status(), 200);
          const route: unknown = await routeResponse.json();
          assert(route && typeof route === 'object' && 'spaceSlug' in route && typeof route.spaceSlug === 'string'
            && 'slug' in route && typeof route.slug === 'string');
          await expect(page).toHaveURL(`${origin}/spaces/${route.spaceSlug}/documents/${route.slug}`);
          await page.reload();
          await expect(title).toHaveValue('Start here');
          await expect(body).toContainText('A saved document has one current revision.');
          const image = body.locator('img').first();
          await expect(image).toBeVisible();
          await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
          if (role === 'reader') {
            await expect(page.getByRole('button', { name: 'New space', exact: true })).toHaveCount(0);
            await expect(title).toHaveAttribute('readonly', '');
            await expect(body).toHaveAttribute('aria-readonly', 'true');
            await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
          } else {
            stage = 'administrator space dialog and keyboard cancellation';
            const trigger = page.getByRole('button', { name: 'New space', exact: true });
            await trigger.click();
            const dialog = page.getByRole('dialog', { name: 'New space', exact: true });
            await expect(dialog.getByLabel('Space name')).toBeFocused();
            await dialog.getByLabel('Space name').fill('Synthetic workspace example');
            await page.screenshot({ path: `${evidenceDirectory}/new-space.png`, mask: [page.locator('.account')], maskColor: '#1b1e20' });
            await page.keyboard.press('Escape');
            await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
            await expect(title).toHaveValue('Start here');
            stage = 'administrator current space access and exact account lookup';
            await page.getByRole('button', { name: 'Space access', exact: true }).click();
            const accessDialog = page.getByRole('dialog', { name: 'Space access', exact: true });
            await expect(accessDialog.getByRole('combobox', { name: `Access for ${credentials.accounts.reader.email}` })).toBeVisible();
            await accessDialog.getByLabel('Existing account email').fill(credentials.accounts.reader.email);
            await page.screenshot({ path: `${evidenceDirectory}/space-access.png`, mask: [page.locator('.account')], maskColor: '#1b1e20' });
            const lookup = await context.request.post(`${origin}/api/v1/users/lookup`, { headers: { origin }, data: { email: credentials.accounts.reader.email } });
            assert.equal(lookup.status(), 200);
            const profile: unknown = await lookup.json();
            assert(profile && typeof profile === 'object' && 'id' in profile && profile.id === credentials.accounts.reader.id);
            assert.deepEqual(Object.keys(profile).sort(), ['email', 'id', 'name', 'role']);
            await accessDialog.getByRole('button', { name: 'Done', exact: true }).click();
            await expect(page.getByRole('button', { name: 'Space access', exact: true })).toBeFocused();
            await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
            await page.screenshot({ path: `${evidenceDirectory}/workspace.png`, mask: [page.locator('.account')], maskColor: '#1b1e20' });
            await image.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `${evidenceDirectory}/private-image.png`, mask: [page.locator('.account')], maskColor: '#1b1e20' });
            await page.evaluate(() => window.scrollTo(0, 0));
          }
          stage = `${role} indexed search`;
          await page.getByRole('button', { name: 'Search documents', exact: true }).click();
          const search = page.getByRole('dialog', { name: 'Search documents', exact: true });
          await search.getByRole('combobox').fill('runbook');
          await expect(search.getByRole('option').first()).toContainText('Service runbook');
          if (role === 'administrator') await page.screenshot({ path: `${evidenceDirectory}/search.png`, mask: [page.locator('.account')], maskColor: '#1b1e20' });
          await page.keyboard.press('Escape');
          stage = `${role} immutable history`;
          await page.getByRole('button', { name: 'History', exact: true }).click();
          const history = page.getByRole('complementary', { name: 'Revision history' });
          await expect(history.getByRole('button', { name: 'Revision 1', exact: true })).toBeVisible();
          await history.getByRole('button', { name: 'Revision 1', exact: true }).click();
          await expect(page.getByRole('textbox', { name: 'Revision content', exact: true })).toContainText('This is a synthetic workspace');
          await page.getByRole('button', { name: 'Close history', exact: true }).click();
          stage = `${role} native authorized export`;
          const response: APIResponse = await context.request.get(`${origin}/api/v1/documents/${manifest.startDocumentId}`);
          assert.equal(response.status(), 200);
          const saved: unknown = await response.json();
          assert(saved && typeof saved === 'object' && 'revision' in saved && saved.revision && typeof saved.revision === 'object'
            && 'content' in saved.revision);
          await page.locator('summary[aria-label="Document actions"]').click();
          const pending = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
          const download = await pending;
          const stream = await download.createReadStream();
          assert(stream);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          const exported: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert(exported && typeof exported === 'object' && 'content' in exported);
          assert.deepEqual(validateContent(exported.content).content, validateContent(saved.revision.content).content);
          if (role === 'administrator') {
            stage = 'saved native tables, checklists and code';
            const startUrl = page.url();
            await page.getByRole('link', { name: 'Service runbook', exact: true }).click();
            await expect(title).toHaveValue('Service runbook');
            await expect(body.locator('code').first()).toContainText('curl --fail');
            await expect(body.locator('table').first()).toBeVisible();
            await body.locator('table').first().scrollIntoViewIfNeeded();
            await page.screenshot({ path: `${evidenceDirectory}/rich-document.png`, mask: [page.locator('.account')], maskColor: '#1b1e20' });
            await page.goBack();
            await expect(page).toHaveURL(startUrl);
            await expect(title).toHaveValue('Start here');
            await page.goForward();
            await expect(title).toHaveValue('Service runbook');
            await page.getByRole('link', { name: 'Start here', exact: true }).click();
            await expect(title).toHaveValue('Start here');
            stage = 'usable narrow-screen navigation';
            await page.setViewportSize({ width: 390, height: 844 });
            await expect(page.getByRole('button', { name: 'Navigation', exact: true })).toBeVisible();
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({ path: `${evidenceDirectory}/mobile.png`, mask: [page.locator('.account')], maskColor: '#1b1e20' });
          }
        }
        stage = `${role} logout`;
        await page.getByRole('button', { name: 'Log out', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
        console.log(`Verified ${role} in a fresh browser session.`);
      } finally { await context.close(); }
    }
    if ('publication' in manifest && manifest.publication && typeof manifest.publication === 'object'
      && 'publicId' in manifest.publication && typeof manifest.publication.publicId === 'string') {
      stage = 'anonymous selected publication and scoped image';
      assert(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(manifest.publication.publicId));
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        page.on('pageerror', () => failures.push('Browser execution failed'));
        await page.goto(`${origin}/publications/${manifest.publication.publicId}`);
        await expect(page.getByRole('heading', { name: 'Start here', exact: true })).toBeVisible();
        const body = page.getByRole('textbox', { name: 'Published document content', exact: true });
        await expect(body).toHaveAttribute('aria-readonly', 'true');
        const image = body.locator('img').first();
        await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
        await expect(page.getByRole('button', { name: /^(?:Log in|Log out|Save|History|Search documents)$/ })).toHaveCount(0);
        await page.screenshot({ path: `${evidenceDirectory}/publication.png` });
        await page.getByRole('link', { name: 'What Save commits', exact: true }).click();
        await expect(body.getByRole('heading', { name: 'What Save commits', exact: true })).toBeFocused();
        console.log('Verified anonymous selected publication and scoped image in a fresh browser session.');
      } finally { await context.close(); }
    }
    assert.equal(failures.length, 0, 'No browser execution errors');
    console.log('Running demo verified. Read-only checks created no document revisions or fixture resets.');
  } catch {
    // Browser diagnostics can include supplied authentication values and headers.
    throw new Error(`Running demo verification failed during ${stage}. Credentials and cookies omitted.`);
  } finally { await browser.close(); }

  async function login(page: Page, role: DemoRole) {
    const password = page.getByLabel('Password', { exact: true });
    try {
      stage = `${role} login email entry`;
      await page.getByLabel('Email', { exact: true }).fill(credentials.accounts[role].email);
      stage = `${role} login password entry`;
      await password.fill(credentials.accounts[role].password);
      const attempt = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/sign-in/email'
        && response.request().method() === 'POST');
      stage = `${role} login submission`;
      await page.getByRole('button', { name: 'Log in', exact: true }).click();
      stage = `${role} authentication response`;
      const response = await attempt;
      // Retained previews keep their real rate limiter. Report only the status,
      // never request bodies, cookies, headers or an automatically retried login.
      stage = `${role} fresh-session login (HTTP ${response.status()})`;
      assert.equal(response.status(), 200, 'Authentication must succeed before checking workspace controls');
      await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
    } finally { if (await password.isVisible()) await password.fill(''); }
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Running demo verification failed.'); process.exitCode = 1; });
