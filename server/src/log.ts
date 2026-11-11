import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = process.env.BEO_DATA ? path.resolve(process.env.BEO_DATA) : path.join(root, 'data');
export const logFile = path.join(dataDir, 'server.log');

/** Appends a line to data/server.log. Never throws. */
export function record(line: string) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, `${logFile}.old`);
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* Logging must never be the reason the server fails. */ }
}
