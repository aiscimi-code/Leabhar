import { test, expect, type Page } from '@playwright/test';

/**
 * Smoke: login → demo variants → year-end / company settings / forms / export.
 * Covers acceptance for issue #283 in one focused Chromium file.
 */

const USER = { displayName: 'Smoke Tester', username: 'smoke', password: 'smokepass1' };

const ENTITY_LABEL: Record<'company' | 'sole_trader' | 'partnership', RegExp> = {
  company: /^Company$/,
  sole_trader: /^Sole trader$/,
  partnership: /^Partnership$/,
};

const LEGAL_NAME: Record<'company' | 'sole_trader' | 'partnership', RegExp> = {
  company: /Acme Software Limited/,
  sole_trader: /Joseph O['\u2019]Sullivan/,
  partnership: /Acme Software Partners/,
};

async function setupOwner(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Set up Leabhar|Log in/ })).toBeVisible();
  if (await page.locator('input[name="displayName"]').count()) {
    await page.locator('input[name="displayName"]').fill(USER.displayName);
    await page.locator('input[name="username"]').fill(USER.username);
    await page.locator('input[name="password"]').fill(USER.password);
    await page.getByRole('button', { name: /Create user and log in/i }).click();
  } else {
    await page.locator('input[name="username"]').fill(USER.username);
    await page.locator('input[name="password"]').fill(USER.password);
    await page.getByRole('button', { name: /Log in/i }).click();
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
}

function entityTypeCell(page: Page, entityType: keyof typeof ENTITY_LABEL) {
  return page.locator('td').filter({ hasText: ENTITY_LABEL[entityType] }).first();
}

/**
 * Load a demo variant. Seeding is slow (documents + statutes). Ready means the
 * Business type panel shows the requested entity — not merely that a person
 * name appears elsewhere on the page (a company has Joseph as a director).
 */
async function loadDemo(page: Page, entityType: 'company' | 'sole_trader' | 'partnership'): Promise<void> {
  await page.goto('/settings/company');
  if (await entityTypeCell(page, entityType).count()) {
    await expect(page.getByRole('heading', { name: 'Business type' })).toBeVisible();
    return;
  }
  const button = page.getByTestId(`load-demo-${entityType}`);
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  await expect(
    page.getByTestId('demo-load-ok').or(entityTypeCell(page, entityType)).first(),
  ).toBeVisible({ timeout: 180_000 });
  await page.reload();
  await expect(entityTypeCell(page, entityType)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(LEGAL_NAME[entityType]).first()).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('company, sole trader and partnership demos render; forms and export round-trip', async ({ page }) => {
  test.setTimeout(12 * 60_000);

  await setupOwner(page);

  // ---- Limited company ----
  await loadDemo(page, 'company');
  await page.goto('/reports/year-end');
  await expect(page.getByRole('heading', { name: /Year-end pack/i })).toBeVisible();
  await expect(page.getByText('Corporation tax computation')).toBeVisible();
  await expect(page.getByText(/Losses carried forward|Close company surcharge|CT1 return/i).first()).toBeVisible();

  await expect(page.getByText('Tax treatments to decide')).toBeVisible();
  await page.getByRole('button', { name: 'Record' }).first().click();
  await expect(page.getByText('Treatment recorded.')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText('Decided', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  await page.goto('/settings/company');
  await expect(page.getByRole('heading', { name: 'Business type' })).toBeVisible();
  await expect(entityTypeCell(page, 'company')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.goto('/reports/year-end');
  await page.getByRole('link', { name: 'Export pack' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/i);

  // ---- Sole trader ----
  await loadDemo(page, 'sole_trader');
  await page.goto('/reports/year-end');
  await expect(page.getByText(/Income tax \d{4}/)).toBeVisible();
  await expect(page.getByText('Corporation tax computation')).toHaveCount(0);
  await page.goto('/settings/company');
  await expect(entityTypeCell(page, 'sole_trader')).toBeVisible();

  // ---- Partnership: partners form ----
  await loadDemo(page, 'partnership');
  await page.goto('/reports/year-end');
  await expect(page.getByText(/Income tax \d{4}/)).toBeVisible();

  await page.goto('/settings/company');
  await expect(entityTypeCell(page, 'partnership')).toBeVisible();
  await expect(page.getByText(/Joseph O['\u2019]Sullivan/).first()).toBeVisible();

  await page.locator('summary', { hasText: 'Add a partner' }).click();
  const addForm = page.locator('form', { has: page.getByRole('button', { name: 'Add partner' }) });
  await addForm.locator('input[name="name"]').fill('Aoife Byrne');
  await addForm.locator('input[name="share"]').fill('0');
  await addForm.locator('input[name="joinedOn"]').fill('2025-06-01');
  await addForm.getByRole('button', { name: 'Add partner' }).click();
  await expect(page.getByText('Partner recorded.')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Aoife Byrne' }).first()).toBeVisible();

  const row = page.locator('tr', { hasText: 'Aoife Byrne' });
  await row.locator('input[name="share"]').fill('5');
  await row.locator('input[name="from"]').fill('2025-07-01');
  await row.getByRole('button', { name: 'Change share' }).click();
  await expect(page.getByText('Share recorded.')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(row.getByText('5.00%')).toBeVisible();
});
