import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { SkillsState } from '../../shared/types.ts';
import { DATA } from './store.ts';

// Superpowers (https://github.com/obra/superpowers, MIT) is cloned on demand, never bundled.

export const SUPERPOWERS_DIR = path.join(DATA, 'vendor', 'superpowers');
const REPO = 'https://github.com/obra/superpowers';

export function skillsState(): SkillsState {
  const dir = path.join(SUPERPOWERS_DIR, 'skills');
  if (!fs.existsSync(dir)) return { installed: false, skills: [] };
  const skills = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => {
      const text = fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8');
      const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
      return { name: e.name, description };
    });
  return { installed: true, skills };
}

export function installSuperpowers(): Promise<SkillsState> {
  const exists = fs.existsSync(path.join(SUPERPOWERS_DIR, '.git'));
  const args = exists ? ['-C', SUPERPOWERS_DIR, 'pull', '--ff-only'] : ['clone', '--depth', '1', REPO, SUPERPOWERS_DIR];
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 120_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`git failed: ${stderr || err.message}`));
      else resolve(skillsState());
    });
  });
}

export function brainstormingSkill(): string {
  const file = path.join(SUPERPOWERS_DIR, 'skills', 'brainstorming', 'SKILL.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\s*/, '') : '';
}

/** Skill text for providers that cannot load the plugin natively. */
export function skillText(names: string[]): string {
  const parts: string[] = [];
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    const file = path.join(SUPERPOWERS_DIR, 'skills', name, 'SKILL.md');
    if (fs.existsSync(file)) parts.push(`## Skill: ${name}\n\n${fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\s*/, '')}`);
  }
  return parts.join('\n\n');
}
