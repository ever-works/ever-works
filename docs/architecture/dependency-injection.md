---
id: dependency-injection
title: Dependency Injection
sidebar_label: Dependency Injection
sidebar_position: 10
---

# Dependency Injection

The Ever Works platform relies heavily on NestJS dependency injection (DI) to manage service lifecycles, facilitate testing, and enforce clean architectural boundaries. This guide covers the DI patterns used throughout the codebase, including module providers, custom decorators, scoped injection, and testing strategies.

## DI Architecture Overview

```
                      ApiModule (Root)
                          |
         +----------------+------------------+
         |                |                  |
    AuthModule      DirectoriesModule    MonitoringModule
         |                |                  |
    AuthService      DirectoryRepo      AnalyticsService
    JwtStrategy      MemberRepo         SentryService
    OAuthService     ...                 ...
         |
    UserRepository  <--- Injected from DatabaseModule
    RefreshTokenRepo
    OAuthTokenRepo

    Global Providers (APP_GUARD, APP_INTERCEPTOR):
      - JwtAuthGuard
      - ThrottlerGuard
      - LoggingInterceptor
      - SentryInterceptor
      - PostHogInterceptor
```

## Provider Registration

### Standard Providers

Most services are registered as simple class providers in their module:

```typescript
@Module({
    providers: [
        AuthService,
        LocalStrategy,
        JwtStrategy,
        GithubAuthStrategy,
        GoogleAuthStrategy,
        TokenCleanupService,
        OAuthUrlService,
    ],
    exports: [AuthService],
})
export class AuthModule {}
```

### Global Guards and Interceptors

Guards and interceptors registered with `APP_GUARD` and `APP_INTERCEPTOR` tokens apply to every route:

```typescript
// apps/api/src/api.module.ts
@Module({
    providers: [
        {
            provide: APP_GUARD,
            useClass: JwtAuthGuard,       // Auth on every route
        },
        {
            provide: APP_GUARD,
            useClass: ThrottlerGuard,     // Rate limit on every route
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: LoggingInterceptor,  // Request/response logging
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: SentryInterceptor,   // Error tracking
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: PostHogInterceptor,  // Analytics
        },
    ],
})
export class ApiModule {}
```

### Value Providers

Simple values or configuration objects can be injected as providers:

```typescript
// packages/monitoring/src/sentry/sentry.module.ts
@Module({})
export class SentryModule {
    static forRoot(config?: SentryConfig) {
        const isInitialized = initSentry(config);
        return {
            module: SentryModule,
            global: true,
            providers: [
                {
                    provide: 'SENTRY_INITIALIZED',
                    useValue: isInitialized,
                },
            ],
            exports: ['SENTRY_INITIALIZED'],
        };
    }
}
```

### Factory Providers

Complex initialization logic uses `useFactory`:

```typescript
// packages/agent/src/database/database.module.ts
TypeOrmModule.forRootAsync({
    imports: [ConfigModule],
    useFactory: (configService: ConfigService) => {
        const config = configService.get('database');
        const logger = new Logger('DatabaseModule');
        logger.debug(`Using ${config.type} database: ${config.database}`);
        return config;
    },
    inject: [ConfigService],
}),
```

## Custom Decorators

### @Public() -- Skip Authentication

```typescript
// apps/api/src/auth/decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

Used in the `JwtAuthGuard` to check if a route is public:

```typescript
canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
        IS_PUBLIC_KEY,
        [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;
    return super.canActivate(context);
}
```

### @CurrentUser() -- Extract Authenticated User

```typescript
// apps/api/src/auth/decorators/user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
    (data: unknown, ctx: ExecutionContext) => {
        const request = ctx.switchToHttp().getRequest();
        return request.user;
    },
);
```

Usage in controllers:

```typescript
@Get('profile')
async getProfile(@CurrentUser() user: JwtPayload) {
    return this.authService.getUserProfile(user.sub);
}
```

## The Facade Pattern and DI

The facade layer demonstrates how DI enables the plugin architecture. Each facade inherits from `BaseFacadeService` and receives dependencies through constructor injection:

```typescript
@Injectable()
export class AiFacadeService extends BaseFacadeService implements IAiFacade {
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.AI_PROVIDER;

    constructor(
        registry: PluginRegistryService,           // From PluginsModule (global)
        settingsService: PluginSettingsService,     // From PluginsModule (global)
        @Optional() directoryPluginRepository?: DirectoryPluginRepository,
    ) {
        super(registry, settingsService, directoryPluginRepository);
    }
}
```

The `@Optional()` decorator allows the repository to be `undefined` in contexts where it is not available (e.g., worker processes).

The `FacadesModule` bundles all facades together:

```typescript
const FACADES = [
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    OAuthFacadeService,
    DeployFacadeService,
];

@Module({
    imports: [DatabaseModule],
    providers: FACADES,
    exports: FACADES,
})
export class FacadesModule {}
```

## Provider Scopes

NestJS supports three injection scopes:

| Scope       | Lifecycle                         | Use Case                          |
|-------------|-----------------------------------|-----------------------------------|
| `DEFAULT`   | Singleton (one instance per app)  | Services, repositories, facades   |
| `REQUEST`   | New instance per HTTP request     | Request-scoped context            |
| `TRANSIENT` | New instance per injection        | Stateful per-consumer services    |

Most platform services use the default singleton scope. Use request scope sparingly, as it forces all dependents into request scope as well.

```typescript
// Example: Request-scoped provider (use only when necessary)
@Injectable({ scope: Scope.REQUEST })
export class RequestContextService {
    constructor(@Inject(REQUEST) private readonly request: Request) {}
}
```

## Application Lifecycle Hooks

The `ApiModule` uses `OnApplicationBootstrap` to initialize the plugin system after all modules are loaded:

```typescript
@Module({ /* ... */ })
export class ApiModule implements OnApplicationBootstrap {
    constructor(private readonly pluginBootstrap: PluginBootstrapService) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.pluginBootstrap.bootstrap();
    }
}
```

Available lifecycle hooks in order of execution:

1. `onModuleInit()` -- Module initialized, dependencies resolved
2. `onApplicationBootstrap()` -- All modules initialized
3. `onModuleDestroy()` -- Module about to be destroyed
4. `beforeApplicationShutdown()` -- Before connections close
5. `onApplicationShutdown()` -- Final cleanup

## Testing with DI

### Overriding Providers in Tests

NestJS `Test.createTestingModule` allows replacing real services with mocks:

```typescript
const module = await Test.createTestingModule({
    providers: [
        AiFacadeService,
        {
            provide: PluginRegistryService,
            useValue: {
                getByCapability: jest.fn().mockReturnValue([]),
                get: jest.fn(),
            },
        },
        {
            provide: PluginSettingsService,
            useValue: {
                getSettings: jest.fn().mockResolvedValue({}),
            },
        },
    ],
}).compile();

const service = module.get(AiFacadeService);
```

### Testing Guards

Test that guards properly protect routes:

```typescript
const module = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
        AuthService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
    ],
}).compile();
```

## Best Practices

1. **Prefer constructor injection** -- Always inject dependencies via the constructor, never use `ModuleRef.resolve()` unless absolutely necessary.

2. **Export only what is needed** -- Modules should only export the services that other modules actually consume. Keep internal helpers private.

3. **Use `@Optional()` for graceful degradation** -- When a dependency might not be available (like in worker processes), use `@Optional()` to accept `undefined`.

4. **Avoid circular dependencies** -- Use `forwardRef()` only as a last resort. Prefer extracting shared logic into a separate module.

5. **Keep providers singleton** -- Request-scoped providers cascade to dependents and hurt performance. Use them only for true request-scoped concerns.

## Troubleshooting

### "Nest can't resolve dependencies" error

This means a provider is missing from the module's `imports` or `providers`. Check that the module exporting the dependency is imported into the consuming module.

### Circular dependency detected

Extract the shared interface or service into a third module. Both original modules import the shared one.

### Provider undefined at runtime

If using `@Optional()`, the provider may legitimately be `undefined`. Add null checks. If not using `@Optional()`, ensure the provider is registered and exported.

## Related Documentation

- [Module System](./module-system.md) -- Module organization and imports
- [Middleware Pipeline](./middleware-pipeline.md) -- Guard and interceptor injection
- [Configuration Management](./configuration-management.md) -- ConfigModule and DI
- [Performance Tuning](../advanced/performance-tuning.md) -- Provider scope impact
