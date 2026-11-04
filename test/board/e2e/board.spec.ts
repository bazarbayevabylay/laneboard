// Web board V1 in a browser (ADR-0001 §31, S5w DoD): tabs, filters equal to `laneboard view`, task panel, final column,
// archive search, a CLI write shown live within 2 s, no CSP refusals or console errors; light and dark screenshots.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { startMachine } from './fixture.ts';
import type { Machine } from './fixture.ts';

let m: Machine;
// Console errors, warnings and page errors of the current test (CSP refusals arrive as console errors "Refused to …").
let problems: string[] = [];

test.beforeAll(async () => {
  m = await startMachine();
});
test.afterAll(async () => {
  await m?.stop();
});

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
});
test.afterEach(() => {
  expect(problems.filter((p) => p.includes('Refused to')), 'CSP refusals').toEqual([]);
  expect(problems, 'console errors and warnings').toEqual([]);
});

interface ViewJson {
  columns: Array<{ status: string; cards: Array<{ id: string }> }>;
  final_status: string;
  final_shown: number;
}

// `laneboard view --json` data of the SHOP board with the same filters.
function cliView(args: string[]): ViewJson {
  return (JSON.parse(m.lb(m.shop, ['view', ...args, '--json'])) as { data: ViewJson }).data;
}

// Card ids per non-final column as the page shows them, and the final column's count.
async function uiView(page: Page, final: string): Promise<{ columns: Record<string, string[]>; finalCount: string }> {
  const columns: Record<string, string[]> = {};
  for (const lane of await page.locator('[data-testid=lanes] section.lane').all()) {
    const status = (await lane.getAttribute('data-status')) ?? '';
    if (status === final) continue;
    columns[status] = await lane.locator('.card').evaluateAll((cards) => cards.map((c) => c.getAttribute('data-task') ?? ''));
  }
  const finalCount = (await page.locator(`section.lane[data-status="${final}"] .lane-h .n`).textContent()) ?? '';
  return { columns, finalCount };
}

// What the CLI view says, in the same shape.
function expectedView(v: ViewJson): { columns: Record<string, string[]>; finalCount: string } {
  const columns: Record<string, string[]> = {};
  for (const c of v.columns) if (c.status !== v.final_status) columns[c.status] = c.cards.map((x) => x.id);
  return { columns, finalCount: String(v.final_shown) };
}

// Open the SHOP board and wait for its cards.
async function openShop(page: Page): Promise<void> {
  await page.goto(m.url);
  await expect(page.locator('h1')).toHaveText('shop');
  await expect(page.locator('.card[data-task="SHOP-1"]')).toBeVisible();
}

test('tabs: both boards of the machine, the started one first; a tab switches the board', async ({ page }) => {
  await openShop(page);
  const tabs = page.locator('.tabs a.tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveAttribute('data-board', 'SHOP');
  await expect(tabs.nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(tabs.nth(0).locator('.cnt')).toHaveText('6');
  await tabs.nth(1).click();
  await expect(page.locator('h1')).toHaveText('api');
  await expect(page).toHaveURL(/\?board=API$/);
  await expect(page.locator('.card[data-task="API-8"]')).toBeVisible();
  await expect(page.locator('.card[data-task^="SHOP-"]')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('h1')).toHaveText('shop');
});

test('filters assignee, label and text show the same cards as laneboard view with those options', async ({ page }) => {
  await openShop(page);
  const final = cliView([]).final_status;
  expect(await uiView(page, final)).toEqual(expectedView(cliView([])));

  await page.locator('select[name=assignee]').selectOption('backend-developer');
  await expect.poll(() => uiView(page, final)).toEqual(expectedView(cliView(['--assignee', 'backend-developer'])));
  await expect(page).toHaveURL(/assignee=backend-developer/);

  await page.locator('select[name=label]').selectOption('bug');
  await expect.poll(() => uiView(page, final)).toEqual(expectedView(cliView(['--assignee', 'backend-developer', '--label', 'bug'])));

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.locator('input[name=text]').fill('CDN');
  await expect.poll(() => uiView(page, final)).toEqual(expectedView(cliView(['--text', 'CDN'])));

  await page.locator('input[name=text]').fill('no such words');
  await expect(page.locator('.nores')).toContainText('No tasks match these filters.');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect.poll(() => uiView(page, final)).toEqual(expectedView(cliView([])));
});

test('task panel: description and comments as text, history, links and attachment names; Esc closes it', async ({ page }) => {
  await openShop(page);
  await page.locator('.card[data-task="SHOP-4"]').click();
  const panel = page.getByTestId('task-panel');
  await expect(panel.locator('.p-title')).toHaveText('Cart total ignores the discount code after a page reload');
  await expect(page).toHaveURL(/task=SHOP-4/);
  await expect(panel.locator('.prose')).toContainText('<b>Not HTML</b>: shown as text.');
  await expect(panel.locator('.prose b')).toHaveCount(0);
  await expect(panel.locator('.links')).toContainText('bd7c26a');
  await expect(panel.locator('.links a[href="https://example.com/issues/42"]')).toBeVisible();
  await expect(panel.locator('.files .nm')).toHaveText(['cart-repro.log']);
  await expect(panel.locator('.files .sz')).toHaveText(['65 B']);
  await expect(panel.locator('.hist .q')).toHaveText([
    'Reproduced: the cart reads the code from session storage before it is restored.',
    'Fix in progress: restore the code first, then compute the total.',
  ]);
  await expect(panel.locator('.hist li b')).toContainText(['Created', 'Comment', 'Comment', 'Attached']);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/task=/);
});

test('the final column starts collapsed, opens to the newest five and loads the rest', async ({ page }) => {
  await page.goto(`${m.url}?board=API`);
  const done = page.locator('section.lane[data-status="done"]');
  await expect(done.locator('.lane-h .n')).toHaveText('7');
  await expect(done.locator('.drow')).toHaveCount(0);
  await done.getByRole('button', { name: 'Show the done tasks' }).click();
  await expect(done.locator('.drow')).toHaveCount(5);
  await done.getByRole('button', { name: '2 more' }).click();
  await expect(done.locator('.drow')).toHaveCount(7);
  await expect(done.getByRole('button', { name: /more$/ })).toHaveCount(0);
  await done.locator('.drow[data-task="API-1"]').click();
  await expect(page.getByTestId('task-panel').locator('.p-title')).toHaveText('Released endpoint number 1');
});

test('archive search finds an archived task and opens it', async ({ page }) => {
  await openShop(page);
  await page.getByTestId('open-archive').click();
  const archive = page.getByTestId('archive');
  await expect(archive.locator('.arow')).toHaveCount(1);
  await archive.locator('input[name=q]').fill('landing');
  await expect(page).toHaveURL(/view=archive&q=landing/);
  await expect(archive.locator('.arow[data-task="SHOP-9"]')).toBeVisible();
  await archive.locator('input[name=q]').fill('nothing like this');
  await expect(archive).toContainText('No archived task matches “nothing like this”.');
  await archive.locator('input[name=q]').fill('old');
  await archive.locator('.arow[data-task="SHOP-9"]').click();
  await expect(page.getByTestId('task-panel').locator('.fields')).toContainText('Archived');
});

test('a write from the CLI shows up without a reload within 2 s', async ({ page }) => {
  await page.goto(`${m.url}?board=API`);
  await expect(page.getByTestId('live')).toContainText('Live');
  await expect(page.locator('.card[data-task="API-8"]')).toBeVisible();
  m.lb(m.api, ['create', 'Arrives while the page is open', '--status', 'in_progress', '--assignee', 'dev-9', '--as', 'dev-9']);
  await expect(page.locator('section.lane[data-status="in_progress"] .card[data-task="API-9"]')).toBeVisible({ timeout: 2000 });
  m.lb(m.api, ['comment', 'API-8', 'a comment from the CLI', '--as', 'dev-9']);
  await page.locator('.card[data-task="API-8"]').click();
  m.lb(m.api, ['comment', 'API-8', 'second comment while the panel is open', '--as', 'dev-9']);
  await expect(page.getByTestId('task-panel').locator('.hist .q').last()).toHaveText('second comment while the panel is open', { timeout: 2000 });
});

// Screenshot of the SHOP board with the final column open and SHOP-4 in the panel; copied to LB_SCREENSHOT_DIR when set.
async function screenshot(page: Page, name: string, outputPath: string): Promise<void> {
  await openShop(page);
  await page.locator('section.lane[data-status="done"]').getByRole('button', { name: 'Show the done tasks' }).click();
  await page.locator('.card[data-task="SHOP-4"]').click();
  await expect(page.getByTestId('task-panel').locator('.hist .q')).toHaveCount(2);
  await page.mouse.move(0, 899);
  await page.screenshot({ path: outputPath });
  const dir = process.env.LB_SCREENSHOT_DIR;
  if (dir) fs.copyFileSync(outputPath, path.join(dir, name));
}

test.describe('screenshots', () => {
  test('light', async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await screenshot(page, 's5w-board-light.png', info.outputPath('s5w-board-light.png'));
    expect(await page.evaluate('getComputedStyle(document.body).backgroundColor')).toBe('rgb(247, 247, 248)');
  });

  test('dark', async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await screenshot(page, 's5w-board-dark.png', info.outputPath('s5w-board-dark.png'));
    expect(await page.evaluate('getComputedStyle(document.body).backgroundColor')).toBe('rgb(15, 15, 16)');
  });
});
