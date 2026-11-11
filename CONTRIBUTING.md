# Contributing

Thanks for helping. A few things keep the project easy to work on:

- `npm run typecheck` and `npm test` must pass. CI runs both on Linux and Windows.
- Code, comments and UI text are in English; add the Turkish UI string next to the English one in `web/src/i18n.tsx`.
- A new provider is one adapter in `server/src/adapters/`: take a prompt, emit state, message, tool and usage events, return the final text and a session.
- Keep the server local-only and keep every state-changing route behind the checks in `server/src/index.ts`.
- Art and sounds must be original or clearly licensed for redistribution.
