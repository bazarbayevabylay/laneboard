// Scrolling the web board (AB-180): a sideways gesture (trackpad, Shift+wheel) over a column moves the board (.lanes),
// an up-down one scrolls the column's cards. The board is wider than the window; a card with the longest label the core
// accepts (40 characters), a long unbroken title and the longest id prefix (10 characters) with a parent mark must not make
// the column itself wider than it is.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { startMachine } from './fixture.ts';
import type { Machine } from './fixture.ts';

let m: Machine;
let long: string;

// Narrower than the four columns (4 × 220 px + gaps), lower than the long todo column.
test.use({ viewport: { width: 760, height: 560 } });

test.beforeAll(async () => {
  m = await startMachine();
  for (let i = 1; i <= 14; i++) m.lb(m.shop, ['create', `Scroll filler task number ${i}`, '--status', 'todo', '--as', 'orchestrator']);
  // A board with the longest prefix: LONGPREFIX-12 is a subtask of LONGPREFIX-1 and has a subtask itself (id, parent mark, kids mark).
  long = path.join(m.home, '..', 'long');
  fs.mkdirSync(long);
  m.lb(long, ['init', '--name', 'long', '--prefix', 'LONGPREFIX', '--description', 'A board with the longest id prefix']);
  for (let i = 1; i <= 11; i++) m.lb(long, ['create', `Long prefix task ${i}`, '--status', 'done', '--as', 'orchestrator']);
  m.lb(long, ['create', 'Subtask with a long parent mark', '--status', 'todo', '--parent', 'LONGPREFIX-1', '--as', 'orchestrator']);
  m.lb(long, ['create', 'Subtask of the subtask', '--status', 'todo', '--parent', 'LONGPREFIX-12', '--as', 'orchestrator']);
  m.lb(m.shop, ['create', 'Callback https://example.com/a/very/long/unbroken/path/that/does/not/wrap/by/itself', '--status', 'todo', '--label', 'a-label-of-the-longest-length-forty-chr', '--as', 'orchestrator']);
});
test.afterAll(async () => {
  await m?.stop();
});

// Open the SHOP board and return the board's lanes and the todo column's card list.
async function openBoard(page: Page): Promise<{ lanes: Locator; todo: Locator }> {
  await page.goto(m.url);
  await expect(page.locator('.card[data-task="SHOP-1"]')).toBeVisible();
  const lanes = page.getByTestId('lanes');
  const todo = page.locator('section.lane[data-status="todo"] .lane-b');
  // Preconditions: the board scrolls sideways, the todo column scrolls down, the column has nothing wider than itself.
  expect(await lanes.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await todo.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await todo.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  return { lanes, todo };
}

// Put the mouse over the middle of an element.
async function hover(page: Page, el: Locator): Promise<void> {
  const box = await el.boundingBox();
  if (!box) throw new Error('the element has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test('a sideways wheel over a column scrolls the board, not the column', async ({ page }) => {
  const { lanes, todo } = await openBoard(page);
  await hover(page, todo);
  await page.mouse.wheel(200, 0);
  await expect.poll(() => lanes.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  expect(await todo.evaluate((el) => el.scrollLeft)).toBe(0);
  expect(await todo.evaluate((el) => el.scrollTop)).toBe(0);
});

test('an up-down wheel over a long column scrolls its cards, not the board', async ({ page }) => {
  const { lanes, todo } = await openBoard(page);
  await hover(page, todo);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => todo.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await lanes.evaluate((el) => el.scrollLeft)).toBe(0);
});

test('the longest id prefix with a parent mark stays inside its card: the column does not get wider', async ({ page }) => {
  await page.goto(`${m.url}?board=LONGPREFIX`);
  const card = page.locator('.card[data-task="LONGPREFIX-12"]');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('parent-mark')).toBeVisible();
  await expect(card.getByTestId('children-mark')).toBeVisible();
  // The task's own id is shown whole; the parent mark gives way (its title keeps the full id).
  const id = card.locator('.c-top > .mono').first();
  expect(await id.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const todo = page.locator('section.lane[data-status="todo"] .lane-b');
  expect(await todo.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
});
