---
id: module-system
title: Module System
sidebar_label: Module System
sidebar_position: 11
---

# Module System

The Ever Works platform is organized as a NestJS monorepo with a layered module architecture. This guide covers how feature modules, shared modules, dynamic modules, and global modules are structured, and how to avoid common pitfalls like circular dependencies.

## Module Hierarchy

```
ApiModule (Root)
  |
  +-- AuthModule                    Feature module (controllers + services)
  |     +-- PassportModule
  |     +-- JwtModule.registerAsync()
  |     +-- DatabaseModule
  |
  +-- DirectoriesModule             Feature module
  |     +-- DatabaseModule
  |     +-- FacadesModule
  |     +-- MailModule
  |
  +-- MonitoringModule.forRoot()    Global dynamic module
  |     +-- SentryModule.forRoot()
  |     +-- PostHogModule.forRoot()
  |
  +-- ThrottlerModule.forRoot()     Global (from @nestjs/throttler)
  +-- ScheduleModule.forRoot()      Global (from @nestjs/schedule)
  +-- EventEmitterModule.forRoot()  Global (from @nestjs/event-emitter)
  +-- CacheFactory.TypeORM()        Global cache
  +-- AgentPluginsModule.forRoot()  Global plugin system
  |
  +-- SubscriptionsModule
  +-- NotificationsModule
  +-- ScreenshotModule
  +-- PluginsModule
  +-- GitProviderModule
  +-- OAuthModule
  +-- DeployModule
  +-- AiConversationModule
  +-- TriggerInternalModule
  +-- TwentyCrmModule.forRoot()
```

## Module Categories

### Feature Modules

Feature modules encapsulate a domain area with its controllers, services, and DTOs:

```typescript
// apps/api/src/auth/auth.module.ts
@Module({
	imports: [
		PassportModule,
		DatabaseModule,
		HttpModule,
		JwtModule.registerAsync({
			useFactory: () => ({
				secret: jwtConstants.secret(),
				signOptions: { expiresIn: jwtConstants.accessTokenExpiration() }
			})
		})
	],
	providers: [
		AuthService,
		LocalStrategy,
		JwtStrategy,
		GithubAuthStrategy,
		GoogleAuthStrategy,
		TokenCleanupService,
		OAuthUrlService
	],
	controllers: [OAuthController, AuthController],
	exports: [AuthService]
})
export class AuthModule {}
```

Key characteristics:

- Declares its own controllers
- Imports only the modules it needs
- Exports only the services other modules need

### Shared Modules

Shared modules provide reusable services with no controllers. They are imported by multiple feature modules:

```typescript
// packages/agent/src/database/database.module.ts
@Module({
	imports: [
		ConfigModule.forFeature(databaseConfig),
		TypeOrmModule.forRootAsync({
			/* ... */
		}),
		TypeOrmModule.forFeature(ENTITIES)
	],
	providers: [
		DirectoryRepository,
		UserRepository,
		RefreshTokenRepository
		// ... all repositories
	],
	exports: [
		TypeOrmModule,
		DirectoryRepository,
		UserRepository,
		RefreshTokenRepository
		// ... all repositories
	]
})
export class DatabaseModule {}
```

`DatabaseModule` is imported by `AuthModule`, `DirectoriesModule`, `FacadesModule`, and others. TypeORM handles deduplication so the database connection is created only once.

### Global Modules

Modules decorated with `@Global()` are available everywhere without explicit imports:

```typescript
// packages/monitoring/src/monitoring.module.ts
@Global()
@Module({})
export class MonitoringModule {
	static forRoot(config?: MonitoringConfig) {
		return {
			module: MonitoringModule,
			global: true,
			imports: [SentryModule.forRoot(config?.sentry), PostHogModule.forRoot(config?.posthog)],
			providers: [AnalyticsService, SentryService],
			exports: [AnalyticsService, SentryService]
		};
	}
}
```

After `MonitoringModule.forRoot()` is imported in `ApiModule`, `AnalyticsService` and `SentryService` are injectable in any module without additional imports.

### Dynamic Modules

Dynamic modules use static methods (`forRoot`, `forRootAsync`, `forFeature`) to accept configuration:

```typescript
// Usage in ApiModule
ThrottlerModule.forRoot(throttlerConfig),

MonitoringModule.forRoot({
    sentry: { dsn: process.env.SENTRY_DSN },
    posthog: { apiKey: process.env.POSTHOG_API_KEY },
}),

CacheFactory.TypeORM({ isGlobal: true }),

TwentyCrmModule.forRoot(),

AgentPluginsModule.forRoot(),
```

The `forRoot()` / `forRootAsync()` pattern is used for one-time configuration at the application root. The `forFeature()` pattern is used for per-module configuration.

## The Facades Module

The `FacadesModule` demonstrates the pattern of bundling related services:

```typescript
const FACADES = [
	AiFacadeService,
	SearchFacadeService,
	ScreenshotFacadeService,
	ContentExtractorFacadeService,
	DataSourceFacadeService,
	GitFacadeService,
	OAuthFacadeService,
	DeployFacadeService
];

@Module({
	imports: [DatabaseModule],
	providers: FACADES,
	exports: FACADES
})
export class FacadesModule {}
```

Note that the `FacadesModule` relies on `PluginsModule` being registered globally -- it does not import it directly. This avoids a circular dependency since facades are consumed by pipeline modules that are also part of the plugin system.

## Application Bootstrap

The `ApiModule` uses `OnApplicationBootstrap` to run post-initialization logic:

```typescript
@Module({
	/* imports, providers */
})
export class ApiModule implements OnApplicationBootstrap {
	constructor(private readonly pluginBootstrap: PluginBootstrapService) {}

	async onApplicationBootstrap(): Promise<void> {
		await this.pluginBootstrap.bootstrap();
	}
}
```

This is the single entry point for plugin discovery and loading. It runs after all modules have been initialized, ensuring all dependencies are available.

## Workspace Package Modules

The monorepo structure maps to NestJS modules via workspace packages:

```
packages/agent/       --> DatabaseModule, FacadesModule, PluginsModule, ...
packages/monitoring/  --> MonitoringModule
packages/tasks/       --> TriggerModule, worker modules
packages/plugin/      --> Plugin contracts (no NestJS module, just types)
packages/contracts/   --> Shared TypeScript types
```

Import workspace packages using the `@ever-works/*` alias:

```typescript
import { DatabaseModule, UserRepository } from '@ever-works/agent/database';
import { MonitoringModule } from '@ever-works/monitoring';
import { config } from '@ever-works/agent/config';
```

## Avoiding Circular Dependencies

### Problem

```
ModuleA imports ModuleB
ModuleB imports ModuleA
--> Circular dependency error
```

### Solutions

1. **Extract shared logic** -- Move the shared service into a third module that both can import:

```
ModuleA --> SharedModule
ModuleB --> SharedModule
```

2. **Use forwardRef()** (last resort):

```typescript
@Module({
	imports: [forwardRef(() => ModuleB)]
})
export class ModuleA {}
```

3. **Use events** -- Instead of direct cross-module calls, use the EventEmitter:

```typescript
// ModuleA emits an event
this.eventEmitter.emit('directory.created', new DirectoryCreatedEvent(directory));

// ModuleB listens for the event (no import of ModuleA needed)
@OnEvent('directory.created')
handleDirectoryCreated(event: DirectoryCreatedEvent) { /* ... */ }
```

The platform uses `EventEmitterModule` extensively to decouple modules.

## Module Registration Checklist

When creating a new feature module:

```
1. [ ] Create the module class with @Module()
2. [ ] List all providers (services, repositories)
3. [ ] List controllers
4. [ ] Import required dependency modules
5. [ ] Export only the services consumed by other modules
6. [ ] Register the module in ApiModule imports
7. [ ] If globally needed, use @Global() or forRoot() with global: true
```

## Best Practices

1. **One module per domain** -- Group related controllers, services, and repositories into a single feature module.

2. **Minimal exports** -- Only export what other modules actually need. Internal helper services should remain private.

3. **Use `forRoot` for configuration** -- Any module that needs runtime configuration should use the dynamic module pattern.

4. **Prefer `@Global()` sparingly** -- Only monitoring, caching, and the plugin registry are truly global. Feature modules should be explicit about their imports.

5. **Events over imports** -- When two modules need to communicate but should not depend on each other, use the event emitter.

## Troubleshooting

### Module not found when importing

Ensure the workspace package is built. Run `pnpm build` from the root, or build the specific package with `turbo build --filter=@ever-works/agent`.

### Provider not available in module

Check that the provider is listed in `exports` of the source module AND that the source module is listed in `imports` of the consuming module.

### Duplicate database connections

If `DatabaseModule` is imported in multiple places, TypeORM deduplicates the connection. If you see duplicate connection warnings, ensure `TypeOrmModule.forRoot` is called only once (in `DatabaseModule`), and other modules use `TypeOrmModule.forFeature`.

## Related Documentation

- [Dependency Injection](./dependency-injection.md) -- Provider types and scoping
- [Middleware Pipeline](./middleware-pipeline.md) -- How modules plug into the request pipeline
- [Configuration Management](./configuration-management.md) -- ConfigModule integration
- [Performance Tuning](../advanced/performance-tuning.md) -- Build optimization with Turborepo
