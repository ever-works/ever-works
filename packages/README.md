# Ever Works Platform Packages

Reusable libraries that make up the Ever Works backend and plugin ecosystem. Every package here is part of the pnpm workspace and is consumed by the apps in [`apps/`](../apps).

## Layout

```
packages/
├── agent/        # Core AI agent logic — work-operations, pipelines, generators, facades
├── cli-shared/   # Shared utilities and prompt services for the public + internal CLIs
├── contracts/    # Pure TypeScript types shared across apps and plugins (zero runtime deps)
├── monitoring/   # NestJS monitoring module — Sentry + PostHog
├── plugin/       # Plugin system contracts, abstract base classes, and testing utilities
├── plugins/      # 40+ plugin implementations (AI providers, search, deploy, pipelines, …)
└── tasks/        # Trigger.dev background job definitions
```

## Packages

| Package                                          | Description                                                             | Visibility |
| ------------------------------------------------ | ----------------------------------------------------------------------- | ---------- |
| [`@ever-works/agent`](agent/README.md)           | Core AI agent logic with 25+ NestJS sub-modules                         | Internal   |
| [`@ever-works/cli-shared`](cli-shared/README.md) | Prompt services and validators shared by the public and internal CLIs   | Public     |
| [`@ever-works/contracts`](contracts/README.md)   | Shared TypeScript types and contracts (item, domain, form, api)         | Public     |
| [`@ever-works/monitoring`](monitoring/README.md) | NestJS module with Sentry error tracking + PostHog analytics            | Public     |
| [`@ever-works/plugin`](plugin/README.md)         | Plugin system contracts, abstract base classes, and test harnesses      | Public     |
| [`@ever-works/trigger-tasks`](tasks/README.md)   | Trigger.dev background tasks for generation, deployment, and scheduling | Internal   |
| [Plugins](plugins/README.md)                     | 40+ first-party plugins (see directory)                                 | Public     |

## Contributing

- See the root [CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md) for repository conventions.
- Build everything: `pnpm build` (Turborepo handles dependency order).
- Build a single package: `turbo run build --filter=@ever-works/<package-name>` or `pnpm --filter <name> build`.
- Run tests: `pnpm test` (root) or `pnpm --filter <name> test` per package.

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Repository](https://github.com/ever-works/ever-works)
- [Specs](../docs/specs)

## License

All Ever Works packages are licensed under [GNU AGPL v3.0](../LICENSE). The public CLI ([`apps/cli`](../apps/cli)) is the only exception and is released under MIT.
