// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { expect, type Page } from '@playwright/test';

export const readingTitle = (page: Page) => page.locator('h1#document-title');

/** Authoring tests explicitly enter edit mode after checking the initial reading view. */
export async function editDocument(page: Page) {
  await expect(readingTitle(page)).toBeVisible();
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  await expect(body).not.toBeEditable();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toBeFocused();
  await expect(body).toBeEditable();
}

/** Native keystrokes replace the model selection; insertText follows Chromium's DOM selection instead. */
export async function replaceDocumentBody(page: Page, value: string) {
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  await page.bringToFront();
  await expect(body).toBeEditable();
  await body.press('ControlOrMeta+a');
  if (value) await page.keyboard.type(value);
  else await page.keyboard.press('Backspace');
  await expect(body).toHaveText(value, { useInnerText: true });
}
