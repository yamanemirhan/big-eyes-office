// Scratch folders live inside the office's data folder, which may itself sit inside a repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'beo-git-'));
const run = (...args: string[]) => execFileSync('git', args, { cwd: parent, stdio: 'ignore' });
run('init', '-q');
fs.writeFileSync(path.join(parent, 'a.txt'), 'a');
run('add', '.');
run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');

process.env.BEO_DATA = path.join(parent, 'data');
const { initScratch, isRepo } = await import('../src/git.ts');

test('a scratch folder never borrows the repository around the data folder', async () => {
  const scratch = path.join(parent, 'data', 'workspaces', 'x');
  fs.mkdirSync(scratch, { recursive: true });
  assert.equal(await isRepo(scratch), false);
  initScratch(scratch);
  assert.equal(await isRepo(scratch), true);
  assert.equal(fs.existsSync(path.join(scratch, '.git')), true);
});

test('a folder the user picks inside a repository still counts as that repository', async () => {
  const sub = path.join(parent, 'packages', 'web');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(await isRepo(sub), true);
});
