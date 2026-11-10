# lil-pstack

Bun-native Cursor SDK coding agent with built-in [pstack](https://github.com/cursor/plugins/tree/main/pstack).

Every prompt runs under poteto-mode. You do not type `/poteto-mode`. Skills still route from the user prompt the way they do in Cursor CLI once poteto-mode is active.

## Setup

```bash
bun install
export CURSOR_API_KEY=...
```

## Run

```bash
bun run src/index.ts
```

Plain prompt mode:

```bash
bun run src/index.ts -- "fix the flaky test"
```

## Checks

```bash
bun check
bun fmt
bun test
bun run parity:pstack
```

`parity:pstack` compares the vendored plugin to the local Cursor pstack source when present, and checks always-on poteto wiring. `parity:pstack:live` proves skill-body inject. `parity:pstack:live-route` proves a plain prompt reads a matched playbook file.

## Refresh vendored pstack

```bash
bun run sync:pstack
```

By default this syncs from `~/.cursor/plugins/local/pstack`. Override with `PSTACK_SOURCE`. Soft deps outside the plugin (`create-skill`, optional `cursor-team-kit` skills such as `deslop` / `control-cli`) stay the same as in Cursor CLI: used when installed on the machine, skipped when absent.
