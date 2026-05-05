# @ever-works/cli-shared

Shared utilities, prompt services, and validators used by the public Ever Works CLI ([`apps/cli`](../../apps/cli)) and the internal CLI ([`apps/internal-cli`](../../apps/internal-cli)).

## Overview

This package keeps the two CLIs DRY. Any prompt flow, validation rule, or formatting helper that both CLIs need lives here so they stay in lock-step without one re-implementing the other.

## Installation

```bash
pnpm add @ever-works/cli-shared
```

## Exports

```typescript
// Prompt services — interactive flows built on inquirer
import { BasePromptService, WorkPromptService } from '@ever-works/cli-shared';

// Utilities
import { checkConfig, slugify, validateSlug, validateUrl, generatorSteps } from '@ever-works/cli-shared';
```

| Export              | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `BasePromptService` | Base class for `inquirer`-driven CLI flows (theming, error formatting) |
| `WorkPromptService` | Prompt flow for creating and editing a Work via the CLI                |
| `checkConfig`       | Validate that a config file is present and well-formed                 |
| `slugify`           | Convert a string into a URL-safe slug                                  |
| `validateSlug`      | Slug validator usable as an inquirer `validate` callback               |
| `validateUrl`       | URL validator usable as an inquirer `validate` callback                |
| `generatorSteps`    | Canonical list of work-generation steps shown in CLI progress output   |

## Dependencies

- [`chalk`](https://github.com/chalk/chalk) for terminal colors
- [`inquirer`](https://github.com/SBoudrias/Inquirer.js) for interactive prompts
- [`fs-extra`](https://github.com/jprichardson/node-fs-extra) for filesystem operations

## Build

```bash
pnpm --filter @ever-works/cli-shared build   # tsc
pnpm --filter @ever-works/cli-shared dev     # tsc --watch
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Repository](https://github.com/ever-works/ever-works)
- [`apps/cli`](../../apps/cli) — public CLI
- [`apps/internal-cli`](../../apps/internal-cli) — internal CLI

## License

AGPL-3.0
