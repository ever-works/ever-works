# @packages/monitoring

A comprehensive monitoring package for NestJS applications that provides seamless integration with **Sentry** for error tracking and **PostHog** for analytics and user behavior tracking.

## ✨ Features

- 🔍 **Sentry Integration**: Real-time error monitoring and performance tracking
- 📝 **Sentry Logs**: Structured logging with automatic context and querying capabilities
- 📊 **PostHog Analytics**: User behavior tracking and event analytics
- 🛡️ **Automatic Interceptors**: Seamless request/response monitoring
- 🎯 **Analytics Service**: Simplified API for custom event tracking
- 🔧 **TypeScript Support**: Full type safety and IntelliSense support
- ⚡ **Zero Configuration**: Works out of the box with sensible defaults
- 🎨 **Modular Design**: Use Sentry, PostHog, or both independently

## 📦 Installation

```bash
# Using pnpm (recommended)
pnpm add @packages/monitoring

# Using npm
npm install @packages/monitoring

# Using yarn
yarn add @packages/monitoring
```

## 🚀 Quick Start

### 1. Environment Variables

Create a `.env` file in your project root:

```env
# Sentry Configuration
SENTRY_DSN=your_sentry_dsn_here
NODE_ENV=production

# PostHog Configuration
POSTHOG_API_KEY=your_posthog_api_key_here
POSTHOG_HOST=https://app.posthog.com
```

### 2. Basic Setup

```typescript
import { Module } from '@nestjs/common';
import { MonitoringModule } from '@packages/monitoring';

@Module({
    imports: [
        MonitoringModule.forRoot({
            sentry: {
                dsn: process.env.SENTRY_DSN,
                environment: process.env.NODE_ENV,
                tracesSampleRate: 0.1,
            },
            posthog: {
                apiKey: process.env.POSTHOG_API_KEY,
                host: process.env.POSTHOG_HOST,
            },
        }),
    ],
})
export class AppModule {}
```

### 3. Global Interceptors (Optional)

```typescript
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MonitoringModule, SentryInterceptor, PostHogInterceptor } from '@packages/monitoring';

@Module({
    imports: [MonitoringModule.forRoot()],
    providers: [
        {
            provide: APP_INTERCEPTOR,
            useClass: SentryInterceptor,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: PostHogInterceptor,
        },
    ],
})
export class AppModule {}
```

## 🔧 Configuration

### Full Configuration Options

```typescript
import { MonitoringModule } from '@packages/monitoring';

@Module({
    imports: [
        MonitoringModule.forRoot({
            sentry: {
                dsn: process.env.SENTRY_DSN,
                environment: process.env.NODE_ENV || 'development',
                tracesSampleRate: 0.1,
                enableLogs: true, // Enable Sentry Logs (enabled by default)
                debug: process.env.NODE_ENV === 'development',
                beforeSend(event) {
                    // Custom filtering logic
                    return event;
                },
            },
            posthog: {
                apiKey: process.env.POSTHOG_API_KEY,
                host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
                flushAt: 20,
                flushInterval: 10000,
            },
        }),
    ],
})
export class AppModule {}
```

### Individual Module Usage

#### Sentry Only

```typescript
import { SentryModule } from '@packages/monitoring/sentry';

@Module({
    imports: [
        SentryModule.forRoot({
            dsn: process.env.SENTRY_DSN,
            environment: process.env.NODE_ENV,
            tracesSampleRate: 0.1,
        }),
    ],
})
export class AppModule {}
```

#### PostHog Only

```typescript
import { PostHogModule } from '@packages/monitoring/posthog';

@Module({
    imports: [
        PostHogModule.forRoot({
            apiKey: process.env.POSTHOG_API_KEY,
            host: process.env.POSTHOG_HOST,
        }),
    ],
})
export class AppModule {}
```

## 📊 Usage

### Analytics Service

The `AnalyticsService` provides a clean API for tracking custom events:

```typescript
import { Controller, Get } from '@nestjs/common';
import { AnalyticsService } from '@packages/monitoring';

@Controller('api')
export class ApiController {
    constructor(private readonly analytics: AnalyticsService) {}

    @Get('users')
    async getUsers() {
        // Track custom event
        this.analytics.track('user123', 'users_fetched', {
            count: 10,
            filter: 'active',
            source: 'api',
        });

        // Track API usage
        this.analytics.trackApiUsage('user123', '/api/users', 'GET', 200, 150);

        // Track authentication event
        this.analytics.trackAuth('user123', 'login', {
            provider: 'google',
            method: 'oauth',
        });

        // Track business event
        this.analytics.trackBusinessEvent('user123', 'purchase', {
            amount: 99.99,
            currency: 'USD',
            product: 'premium_plan',
        });

        return { users: [] };
    }
}
```

### Sentry Logs

Sentry Logs allow you to send structured logs to Sentry, providing valuable context alongside errors and performance data. Logs are automatically enabled by default.

```typescript
import { Injectable } from '@nestjs/common';
import { SentryService } from '@packages/monitoring';

@Injectable()
export class UserService {
    constructor(private readonly sentry: SentryService) {}

    async processUser(userId: string) {
        // Log informational messages
        this.sentry.info('Processing user', { userId, timestamp: new Date().toISOString() });

        try {
            // Your business logic
            const result = await this.userRepository.find(userId);
            
            // Log success
            this.sentry.debug('User found', { userId, resultId: result.id });
            
            return result;
        } catch (error) {
            // Log error with context
            this.sentry.error('Failed to process user', { 
                userId, 
                error: error.message,
                stack: error.stack 
            });
            throw error;
        }
    }

    // You can also use the logger directly for more control
    async advancedLogging() {
        const logger = this.sentry.getLogger();
        
        logger.trace('Detailed trace information', { step: 'initialization' });
        logger.debug('Debug information', { state: 'processing' });
        logger.info('User action completed', { action: 'login' });
        logger.warn('Potential issue detected', { issue: 'rate_limit_approaching' });
        logger.error('Error occurred', { error: 'validation_failed' });
        logger.fatal('Critical failure', { system: 'payment_processor' });
    }
}
```

### Manual Error Tracking

```typescript
import { Injectable } from '@nestjs/common';
import { SentryService } from '@packages/monitoring';

@Injectable()
export class UserService {
    constructor(private readonly sentry: SentryService) {}

    async createUser(userData: any) {
        try {
            // Your business logic
            return await this.userRepository.save(userData);
        } catch (error) {
            // Manual error capture with context
            this.sentry.captureException(error, {
                tags: {
                    section: 'user_creation',
                    userId: userData.id,
                },
                extra: {
                    userData,
                    timestamp: new Date().toISOString(),
                },
            });
            throw error;
        }
    }
}
```

### Custom Event Tracking

```typescript
import { Injectable } from '@nestjs/common';
import { PostHogService } from '@packages/monitoring/posthog';

@Injectable()
export class EventService {
    constructor(private readonly posthog: PostHogService) {}

    async trackCustomEvent(userId: string, event: string, properties: any) {
        this.posthog.capture({
            distinctId: userId,
            event,
            properties: {
                ...properties,
                timestamp: new Date().toISOString(),
            },
        });
    }
}
```

## 🛡️ Interceptors

### Sentry Interceptor

Automatically captures and reports errors:

```typescript
import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { SentryInterceptor } from '@packages/monitoring/interceptors';

@Controller('api')
@UseInterceptors(SentryInterceptor)
export class ApiController {
    @Get('error-prone')
    async errorProneEndpoint() {
        // Any error thrown here will be automatically captured by Sentry
        throw new Error('Something went wrong!');
    }
}
```

### PostHog Interceptor

Automatically tracks API requests:

```typescript
import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { PostHogInterceptor } from '@packages/monitoring/interceptors';

@Controller('api')
@UseInterceptors(PostHogInterceptor)
export class ApiController {
    @Get('tracked')
    async trackedEndpoint() {
        // This request will be automatically tracked by PostHog
        return { message: 'This request is being tracked!' };
    }
}
```

## 📝 TypeScript Support

The package provides comprehensive TypeScript definitions:

```typescript
import {
    MonitoringConfig,
    SentryConfig,
    PostHogConfig,
    AnalyticsEvent,
    UserProperties,
    ApiUsageEvent,
    AuthEvent,
    BusinessEvent,
    MonitoringModuleOptions,
} from '@packages/monitoring/types';

// Example usage with types
const config: MonitoringConfig = {
    sentry: {
        dsn: process.env.SENTRY_DSN!,
        environment: 'production',
    },
    posthog: {
        apiKey: process.env.POSTHOG_API_KEY!,
    },
};
```

## 🧪 Testing

```bash
# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:cov

# Run tests for specific file
pnpm test analytics.service.spec.ts
```

## 🏗️ Build

```bash
# Build the package
pnpm build

# Build in development mode with watch
pnpm build:dev

# Build types only
pnpm build:types
```

## 📚 API Reference

### MonitoringModule

#### `forRoot(config?: MonitoringConfig)`

Configures both Sentry and PostHog modules.

**Parameters:**

- `config` (optional): Configuration object for Sentry and PostHog

**Returns:** `DynamicModule`

### AnalyticsService

#### `track(distinctId: string, event: string, properties?: Record<string, any>, groups?: Record<string, string | number>)`

Tracks a custom event.

**Parameters:**

- `distinctId`: Unique identifier for the user
- `event`: Event name
- `properties`: Optional event properties
- `groups`: Optional group properties

#### `trackApiUsage(distinctId: string, endpoint: string, method: string, statusCode: number, duration: number)`

Tracks API usage metrics.

**Parameters:**

- `distinctId`: User identifier
- `endpoint`: API endpoint path
- `method`: HTTP method
- `statusCode`: Response status code
- `duration`: Request duration in milliseconds

#### `trackAuth(distinctId: string, event: 'login' | 'logout' | 'register' | 'password_reset', properties?: Record<string, any>)`

Tracks authentication events.

#### `trackBusinessEvent(distinctId: string, event: string, properties?: Record<string, any>)`

Tracks business-specific events.

#### `isAvailable(): boolean`

Checks if PostHog is available and properly configured.

### SentryService

Provides access to Sentry's logging and error tracking capabilities.

#### `getLogger()`

Returns the Sentry logger instance for direct access to logging methods.

**Returns:** `Sentry.Logger`

#### `trace(message: string, context?: Record<string, any>)`

Logs a trace-level message.

**Parameters:**
- `message`: Log message
- `context`: Optional context data

#### `debug(message: string, context?: Record<string, any>)`

Logs a debug-level message.

**Parameters:**
- `message`: Log message
- `context`: Optional context data

#### `info(message: string, context?: Record<string, any>)`

Logs an info-level message.

**Parameters:**
- `message`: Log message
- `context`: Optional context data

#### `warn(message: string, context?: Record<string, any>)`

Logs a warning-level message.

**Parameters:**
- `message`: Log message
- `context`: Optional context data

#### `error(message: string, context?: Record<string, any>)`

Logs an error-level message.

**Parameters:**
- `message`: Log message
- `context`: Optional context data

#### `fatal(message: string, context?: Record<string, any>)`

Logs a fatal-level message.

**Parameters:**
- `message`: Log message
- `context`: Optional context data

#### `captureException(exception: any, context?: any)`

Captures an exception and sends it to Sentry.

**Parameters:**
- `exception`: The exception to capture
- `context`: Optional context data (tags, extra, etc.)

#### `captureMessage(message: string, level?: any, context?: any)`

Captures a message and sends it to Sentry.

**Parameters:**
- `message`: The message to capture
- `level`: Optional severity level
- `context`: Optional context data

#### `setUser(user: { id?: string; email?: string; username?: string; [key: string]: any })`

Sets the user context for Sentry events.

**Parameters:**
- `user`: User information object

#### `setContext(name: string, context: Record<string, any>)`

Sets additional context for Sentry events.

**Parameters:**
- `name`: Context name
- `context`: Context data

#### `setTag(key: string, value: string)`

Sets a tag for Sentry events.

**Parameters:**
- `key`: Tag key
- `value`: Tag value

#### `setTags(tags: Record<string, string>)`

Sets multiple tags for Sentry events.

**Parameters:**
- `tags`: Object with tag key-value pairs

#### `isInitialized(): boolean`

Checks if Sentry is initialized and available.

**Returns:** `boolean`

### Interceptors

#### `SentryInterceptor`

Automatically captures errors and sends them to Sentry.

**Features:**

- Automatic error capture
- Request context inclusion
- User information attachment
- Custom tags and metadata

#### `PostHogInterceptor`

Automatically tracks API requests and sends them to PostHog.

## 🙏 Acknowledgments

- [Sentry](https://sentry.io/) for excellent error monitoring
- [PostHog](https://posthog.com/) for powerful analytics
- [NestJS](https://nestjs.com/) for the amazing framework
