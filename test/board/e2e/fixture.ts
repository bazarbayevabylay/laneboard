// Temp machine for the web board e2e: a HOME with two registered boards (SHOP with 8 active tasks and an archived one,
// API with 7 finished tasks), and `laneboard board` from the sources serving them on a free port.
// S5w2 marks on SHOP: SHOP-6 handed in with a result and a PNG attached, SHOP-3 and SHOP-8 subtasks of SHOP-4, SHOP-2 waiting-owner.
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'src', 'cli', 'main.ts');

export interface Machine {
  home: string;
  shop: string;
  api: string;
  url: string;
  // Run the CLI from the sources in a project folder (stdout returned).
  lb(cwd: string, args: string[]): string;
  stop(): Promise<void>;
}

// One PNG chunk: length, type, data, CRC of type + data.
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([head, body, crc]);
}

// A real 390×200 RGB PNG that looks like an e-mail preview (a header band and text lines), so the panel has a picture to show.
export function emailPreviewPng(): Buffer {
  const width = 390;
  const height = 200;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      let rgb = [244, 245, 247];
      if (y < 44) rgb = [33, 83, 199];
      else if (y >= 64 && y < 76 && x >= 24 && x < 220) rgb = [22, 23, 26];
      else if ((y - 92) % 18 < 7 && y >= 92 && y < 164 && x >= 24 && x < 366 - ((y - 92) % 36 === 0 ? 0 : 80)) rgb = [160, 164, 172];
      else if (y >= 172 && y < 192 && x >= 24 && x < 124) rgb = [29, 122, 72];
      row.set(rgb, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}

// Set a task's last change `ageMs` into the past by hand (no write op, so no event and no stream `change`), checksum kept valid.
export function ageTask(project: string, id: string, ageMs: number): void {
  const file = path.join(project, '.laneboard', 'active.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { content_sha256: string; tasks: Array<{ id: string; updated_at: string }> };
  const task = doc.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`${id} is not in ${file}`);
  task.updated_at = new Date(Date.now() - ageMs).toISOString();
  doc.content_sha256 = crypto.createHash('sha256').update(JSON.stringify(doc.tasks)).digest('hex');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  fs.chmodSync(file, 0o444);
}

// Run one CLI command of the temp machine; a failing command fails the setup.
function run(home: string, cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Build the boards and start the server; resolves once it printed its URL.
export async function startMachine(): Promise<Machine> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lb-e2e-')));
  const home = path.join(root, 'home');
  const shop = path.join(root, 'shop');
  const api = path.join(root, 'api');
  for (const d of [home, shop, api]) fs.mkdirSync(d);
  const lb = (cwd: string, args: string[]): string => run(home, cwd, args);

  lb(shop, ['init', '--name', 'shop', '--description', 'ACME web shop: checkout, catalog and the order emails']);
  lb(shop, ['create', 'Fix login redirect losing the query string', '--status', 'todo', '--assignee', 'backend-developer', '--label', 'auth', '--label', 'bug', '--as', 'orchestrator']);
  lb(shop, ['create', 'Add product search with typo tolerance', '--status', 'todo', '--label', 'search', '--as', 'orchestrator']);
  lb(shop, ['create', 'Write the e2e test for the checkout happy path', '--status', 'todo', '--assignee', 'tester', '--label', 'test', '--as', 'orchestrator']);
  lb(shop, [
    'create',
    'Cart total ignores the discount code after a page reload',
    '--status',
    'in_progress',
    '--assignee',
    'claude-code@abylay:f92f65da',
    '--label',
    'bug',
    '--label',
    'checkout',
    '--link',
    'commit=bd7c26a',
    '--link',
    'url=https://example.com/issues/42',
    '--description',
    'Steps: add two items, apply SPRING10, reload the cart page.\nExpected: the discount stays. Actual: the total is back to the full price.\n<b>Not HTML</b>: shown as text.',
    '--as',
    'orchestrator',
  ]);
  lb(shop, ['create', 'Move product images to the CDN', '--status', 'in_progress', '--assignee', 'frontend-developer', '--label', 'perf', '--as', 'orchestrator']);
  lb(shop, ['create', 'Order confirmation email template', '--status', 'todo', '--assignee', 'backend-developer', '--label', 'email', '--as', 'orchestrator']);
  lb(shop, ['create', 'Set up the staging deploy', '--status', 'done', '--assignee', 'devops', '--as', 'orchestrator']);
  lb(shop, ['create', 'Pick the payment provider', '--status', 'done', '--as', 'orchestrator']);
  lb(shop, ['create', 'Old landing page experiment', '--status', 'done', '--as', 'orchestrator']);
  lb(shop, ['archive', 'SHOP-9', '--as', 'orchestrator']);
  lb(shop, ['comment', 'SHOP-4', 'Reproduced: the cart reads the code from session storage before it is restored.', '--as', 'claude-code@abylay:f92f65da']);
  lb(shop, ['comment', 'SHOP-4', 'Fix in progress: restore the code first, then compute the total.', '--as', 'claude-code@abylay:f92f65da']);
  fs.writeFileSync(path.join(shop, 'cart-repro.log'), 'GET /cart 200\nPOST /cart/discount 200\nGET /cart 200 total=120.00\n');
  lb(shop, ['attach', 'SHOP-4', 'cart-repro.log', '--as', 'claude-code@abylay:f92f65da']);
  lb(shop, ['claim', 'SHOP-6', '--status', 'in_progress', '--as', 'backend-developer']);
  fs.writeFileSync(path.join(shop, 'email-preview.png'), emailPreviewPng());
  lb(shop, ['attach', 'SHOP-6', 'email-preview.png', '--as', 'backend-developer']);
  lb(shop, ['finish', 'SHOP-6', '--status', 'review', '--result', 'Template done, preview attached in the PR', '--no-commit', '--as', 'backend-developer']);
  lb(shop, ['update', 'SHOP-3', '--parent', 'SHOP-4', '--as', 'orchestrator']);
  lb(shop, ['update', 'SHOP-8', '--parent', 'SHOP-4', '--as', 'orchestrator']);
  lb(shop, ['update', 'SHOP-2', '--add-label', 'waiting-owner', '--as', 'orchestrator']);
  lb(shop, ['comment', 'SHOP-2', 'Owner: should typos in SKUs match too, or titles only?', '--as', 'orchestrator']);

  lb(api, ['init', '--name', 'api', '--description', 'ACME orders API']);
  for (let i = 1; i <= 7; i++) lb(api, ['create', `Released endpoint number ${i}`, '--status', 'done', '--as', 'orchestrator']);
  lb(api, ['create', 'Rate limit the orders endpoint', '--status', 'todo', '--as', 'orchestrator']);

  const child: ChildProcess = spawn(process.execPath, [CLI, 'board', '--port', '0', '--json'], { cwd: shop, env: { PATH: process.env.PATH ?? '', HOME: home } });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
      const line = out.split('\n')[0];
      if (out.includes('\n') && line) resolve((JSON.parse(line) as { data: { url: string } }).data.url);
    });
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.on('exit', (code) => reject(new Error(`laneboard board exited with ${code}: ${err}`)));
  });
  return {
    home,
    shop,
    api,
    url,
    lb,
    stop: async () => {
      // Ctrl+C: the board closes its server and exits 0.
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGINT');
      await exited;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
