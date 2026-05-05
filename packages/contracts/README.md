# @ever-works/contracts

Shared TypeScript type definitions and runtime-free contracts used across the Ever Works platform.

## Overview

This package contains the cross-cutting type primitives that every other package and app relies on — work items, domain models, form schemas, and API contracts. It has zero runtime dependencies and is published as both ESM and CJS so it can be consumed from Node.js, Next.js, browsers, and the plugin system alike.

`@ever-works/contracts` is a pure type package: no NestJS, no LangChain, no I/O. Anything that needs to be shared between the API, the web app, and standalone plugins lives here.

## Installation

```bash
pnpm add @ever-works/contracts
```

## Subpath exports

| Import path                    | Contents                                                          |
| ------------------------------ | ----------------------------------------------------------------- |
| `@ever-works/contracts`        | Re-exports of `item`, `domain`, and `form` (default barrel)       |
| `@ever-works/contracts/item`   | `ItemData`, item lifecycle states, item field shapes              |
| `@ever-works/contracts/domain` | `DomainType`, domain category metadata                            |
| `@ever-works/contracts/form`   | Form field schemas (`x-widget`, `x-secret`, etc.) consumed by UIs |
| `@ever-works/contracts/api`    | REST API request/response shapes                                  |

## Usage

```typescript
import type { ItemData } from '@ever-works/contracts/item';
import type { DomainType } from '@ever-works/contracts/domain';
import type { JsonSchema } from '@ever-works/contracts/form';

const item: ItemData = {
	name: 'Example',
	slug: 'example'
	// ...
};
```

## Why a separate package?

- **Plugins stay lightweight.** Plugins import only types — no NestJS, no DB, no agent runtime.
- **Type drift is caught at compile time.** API, web, agent, and plugins all share the same source of truth.
- **Cross-runtime safety.** Pure TypeScript means it builds for Node, browser, Edge, and Workers without conditional exports.

## Build

```bash
pnpm --filter @ever-works/contracts build      # tsup -> ESM + CJS + .d.ts
pnpm --filter @ever-works/contracts type-check # tsc --noEmit
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Repository](https://github.com/ever-works/ever-works)
- [Plugin system contracts](../plugin/README.md)

## License

AGPL-3.0
