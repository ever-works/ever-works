---
id: internal-cli
title: Internal CLI Reference
sidebar_label: Internal CLI
sidebar_position: 5
---

# Internal CLI Reference

The internal CLI (`@ever-works/cli`) is a private NestJS-based command-line tool built with [nest-commander](https://docs.nestjs.com/recipes/nest-commander). Unlike the public CLI (which communicates with the API over HTTP), the internal CLI operates directly against the database and agent services, making it suitable for local development, self-hosted deployments, and administrative tasks.

## Architecture

```
apps/internal-cli/
  src/
    main.ts                           # Bootstrap entry point
    cli.module.ts                     # Root NestJS module
    config/
      config.module.ts                # Configuration module
    commands/
      config/
        config.command.ts             # Config command group
        setup.subcommand.ts           # Interactive setup wizard
        show.subcommand.ts            # Display current configuration
        test.subcommand.ts            # Test connectivity
        set.subcommand.ts             # Set a config value
        unset.subcommand.ts           # Remove a config value
        switch-ai.subcommand.ts       # Switch AI provider
      work/
        work.command.ts          # Work command group
        create.subcommand.ts          # Create work
        list.subcommand.ts            # List works
        generate.subcommand.ts        # Generate content
        update.subcommand.ts          # Update work
        submit-item.subcommand.ts     # Submit item
        remove-item.subcommand.ts     # Remove item
        regenerate-markdown.subcommand.ts
        update-website.subcommand.ts
        deploy.subcommand.ts          # Deploy website
        delete.subcommand.ts          # Delete work
      serve/
        serve.command.ts              # Development server
```

## Module Dependencies

The `CLIModule` imports the full agent stack for direct database and service access:

```typescript
@Module({
	imports: [
		CacheFactory.TypeORM({ isGlobal: true }),
		DatabaseConfigurations.cli(),
		EventEmitterModule.forRoot(),
		AgentPluginsModule.forRoot(),
		ConfigModule,
		DatabaseModule,
		DataGeneratorModule,
		ItemsGeneratorModule,
		MarkdownGeneratorModule,
		WebsiteGeneratorModule,
		FacadesModule,
		WorkModule
	]
})
export class CLIModule implements OnApplicationBootstrap {
	async onApplicationBootstrap(): Promise<void> {
		await this.pluginBootstrap.bootstrap();
	}
}
```

On startup, `PluginBootstrapService` initializes all registered plugins before any commands execute.

## Command Groups

### `config`

Configuration management for the internal CLI environment.

| Subcommand  | Description                                 |
| ----------- | ------------------------------------------- |
| `setup`     | Interactive setup wizard for initial config |
| `show`      | Display current configuration values        |
| `test`      | Test database and service connectivity      |
| `set`       | Set a specific configuration value          |
| `unset`     | Remove a configuration value                |
| `switch-ai` | Switch between configured AI providers      |

### `work`

Work management commands that operate directly against the database.

| Subcommand            | Description                                |
| --------------------- | ------------------------------------------ |
| `create`              | Create a new work                     |
| `list`                | List all works                       |
| `generate`            | Generate data and create a repository      |
| `update`              | Update a work and its repository      |
| `submit-item`         | Submit an item to a work              |
| `remove-item`         | Remove an item from a work            |
| `regenerate-markdown` | Regenerate readme markdown for a work |
| `update-website`      | Update the website repository              |
| `deploy`              | Deploy the website for a work         |
| `delete`              | Delete a work and its repositories    |

### `serve`

Start a local development server for testing and development purposes.

## Differences from the Public CLI

| Aspect             | Public CLI (`ever-works`) | Internal CLI (`@ever-works/cli`)    |
| ------------------ | ------------------------- | ----------------------------------- |
| **Framework**      | Commander.js              | nest-commander (NestJS)             |
| **Data access**    | REST API via HTTP         | Direct database + agent services    |
| **Authentication** | JWT token via OAuth       | Database connection (no auth)       |
| **Distribution**   | Public npm package        | Private, monorepo only              |
| **Use case**       | End-user CLI              | Development and admin tasks         |
| **Dependencies**   | API service client        | Full agent stack (TypeORM, plugins) |

## Running the Internal CLI

```bash
# From the monorepo root
cd apps/internal-cli

# Run a command
npx nest-commander config show
npx nest-commander work list
npx nest-commander work generate
```

The CLI uses `DatabaseConfigurations.cli()` which configures the database connection for CLI-mode operation (typically SQLite for local development).
