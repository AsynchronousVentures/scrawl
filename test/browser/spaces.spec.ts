// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { test, expect } from '@playwright/test';
import { createBrowserDemo, type BrowserDemo } from './fixture.js';
import { readingTitle } from './editor-mode.js';

let demo: BrowserDemo;
// Account provisioning alone leaves this explicitly disposable database empty.
// No retained database is reset or modified to manufacture onboarding.
test.beforeAll(async () => { demo = await createBrowserDemo(); });
test.afterAll(async () => { await demo?.close(); });

test('an administrator creates the first space and document in a genuinely empty workspace', async ({ page }) => {
  expect(await demo.database.prisma.space.count()).toBe(0);
  await page.goto(demo.origin);
  const password = page.getByLabel('Password', { exact: true });
  await demo.fillCredentials(page.getByLabel('Email', { exact: true }), password, 'administrator');
  try {
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  } finally {
    demo.authenticationCompleted();
    if (await password.isVisible()) await password.fill('');
  }
  await expect(page.getByRole('heading', { name: 'No accessible spaces' })).toBeVisible();
  await expect(page.getByText('Create a space to organize your documents.', { exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'New space', exact: true });
  await trigger.focus(); await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New space', exact: true });
  await expect(dialog.getByLabel('Space name')).toBeFocused();
  await dialog.getByLabel('Space name').fill('First handbook');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/spaces/*/documents**', async route => {
    if (route.request().method() === 'GET') await held;
    await route.continue();
  });
  try {
    const listing = page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/documents'));
    await dialog.getByLabel('Space name').press('Enter'); await listing;
    // Closing before the first-space read completes tries to restore focus
    // to a still-disabled trigger and strands keyboard users on the body.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create space', exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(`${demo.origin}/spaces/first-handbook`);
  await expect(page.getByRole('heading', { name: 'No documents yet' })).toBeVisible();
  expect(await demo.database.prisma.space.count()).toBe(1);
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document title', exact: true }).fill('Start here');
  await page.getByRole('textbox', { name: 'Document body', exact: true }).fill('The first real saved document.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved · revision 1' })).toBeVisible();
  await page.reload();
  await expect(readingTitle(page)).toHaveText('Start here');
  await expect(page.getByRole('textbox', { name: 'Document body', exact: true })).not.toBeEditable();
  await expect(page.getByRole('textbox', { name: 'Document body', exact: true })).toContainText('The first real saved document.');
  expect(await demo.database.prisma.documentRevision.count()).toBe(1);
});
