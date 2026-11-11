# Security

Big Eyes Office runs AI agents that can read files, edit them and run commands on your computer. Treat it like a terminal you hand to someone else.

## What protects you

- **Local only.** The server listens on `127.0.0.1`. Requests with any other `Host` header are refused, which stops DNS-rebinding pages.
- **No cross-site control.** Every request that changes something needs the app's own `x-beo-client` header and a local `Origin`; a foreign page cannot add that header without a CORS preflight, which the server never grants. The WebSocket, which carries terminal input, accepts only this app's own page.
- **Supervisor token.** The supervisor on `127.0.0.1:47799` accepts commands only with the random token in `data/supervisor.json`.
- **Secrets stay on disk.** API keys are kept in `data/state.json` or `data/office.db` (the whole `data/` folder is git-ignored) and the browser only ever sees them masked.
- **Per-team limits.** Autonomy level, approval switches, permission rules (allow / ask / deny by pattern) and daily budgets.
- **Docker isolation (per team).** Agents run as an unprivileged user in a container with no Linux capabilities, `no-new-privileges`, a read-only system, memory/CPU/process limits, only the working folder mounted, their own state volume, and internet only through an allowlist proxy on an internal network.
- **Git branches.** In a repository, every delegated task works on its own branch and worktree; merges happen one at a time and can require your approval or a passing check.

## What it does not protect against

- Without Docker isolation, agents run as your user. A team set to "Edit and run commands" without approvals can do anything you can.
- A model can be talked into things by content it reads (prompt injection from web pages, issues or files). Use approvals or Docker for untrusted input.
- Webhook URLs contain a secret token; keep them private.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
