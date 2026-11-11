import type { Terminal } from '@xterm/xterm';

/** Open terminal views by shell id, so output arriving on the socket is written straight into them. */
export const terms = new Map<string, Terminal>();
