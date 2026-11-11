// Entry point. Loads the real server behind a guard so that a startup failure
// is explained in the terminal and recorded in data/server.log.

import { logFile, record } from './log.ts';

function fail(title: string, err: unknown) {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`\n  Big Eyes Office could not start: ${title}\n\n${detail}\n\n  Details were saved to ${logFile}\n`);
  record(`FAILED: ${title}\n${detail}`);
  process.exitCode = 1;
}

record(`starting — node ${process.version}, ${process.platform} ${process.arch}`);
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  fail(`Node.js 22 or newer is required, but this is ${process.version}.`, 'Install a current Node.js from https://nodejs.org and run "npm install" again.');
} else {
  // Keep serving after a stray error, and always leave a trace of how the process ended.
  process.on('uncaughtException', (err) => { console.error(err); record(`ERROR (kept running): ${err instanceof Error ? err.stack : String(err)}`); });
  process.on('unhandledRejection', (err) => { console.error(err); record(`REJECTION (kept running): ${err instanceof Error ? err.stack : String(err)}`); });
  process.on('exit', (code) => record(`exit with code ${code}`));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(sig, () => { record(`stopped by ${sig}`); process.exit(0); });
  import('./index.ts').catch((err) => fail('the server code failed to load', err));
}
