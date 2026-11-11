// Team memory: a small Markdown file per team that the lead reads at the start of a run and adds to at the end.
// Kept as a plain file so it is easy to read, edit by hand, and back up.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './store.ts';

const DIR = path.join(DATA, 'memory');
const MAX_CHARS = 20_000;
const file = (teamId: string) => path.join(DIR, `${teamId.replace(/[^\w-]/g, '')}.md`);

export function readMemory(teamId: string): string {
  try { return fs.readFileSync(file(teamId), 'utf8'); } catch { return ''; }
}

export function writeMemory(teamId: string, text: string) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(teamId), text.slice(-MAX_CHARS));
}

export function deleteMemory(teamId: string) {
  fs.rmSync(file(teamId), { force: true });
}

/** Takes the ```memory blocks out of a reply. Returns the reply without them and the new lines. */
export function takeMemory(text: string): { text: string; lines: string[] } {
  const lines: string[] = [];
  const rest = text.replace(/```memory\s*\n([\s\S]*?)```/g, (_m, body: string) => {
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.replace(/^\s*[-*]\s*/, '').trim();
      // Never keep anything that looks like a credential.
      if (line && line.length <= 300 && !/(sk-[a-z0-9-]{10,}|ghp_|github_pat_|api[_-]?key\s*[:=]|password\s*[:=])/i.test(line)) lines.push(line);
    }
    return '';
  });
  return { text: rest.trim(), lines };
}

/** Appends new facts under today's date, skipping lines the memory already has. */
export function addMemory(teamId: string, lines: string[]): string[] {
  const current = readMemory(teamId);
  const known = new Set(current.split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s*/, '').trim().toLowerCase()));
  const fresh = [...new Set(lines)].filter((l) => !known.has(l.toLowerCase()));
  if (!fresh.length) return [];
  const day = new Date().toISOString().slice(0, 10);
  const heading = current.includes(`## ${day}`) ? '' : `\n## ${day}\n`;
  writeMemory(teamId, `${current.trimEnd()}\n${heading}${fresh.map((l) => `- ${l}`).join('\n')}\n`.trimStart());
  return fresh;
}
