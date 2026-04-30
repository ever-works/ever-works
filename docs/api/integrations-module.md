---
id: integrations-module
title: Integrations Module
sidebar_label: Integrations Module
sidebar_position: 14
---

# Integrations Module

The Integrations module provides external CRM connectivity for the Ever Works platform. Currently, it implements a full integration with **Twenty CRM**, an open-source CRM system. The module is located at `apps/api/src/integrations/`.

## Architecture Overview

```
IntegrationsModule
  └── TwentyCrmModule (global, dynamic)
        ├── Config
        │     └── CrmConfigService         -- Environment-based config
        ├── Services
        │     ├── TwentyCrmService          -- HTTP client for Twenty API
        │     ├── ClientService             -- High-level CRUD operations
        │     └── CrmTenantService          -- Multi-tenant context resolution
        ├── Controllers
        │     ├── CompaniesController       -- Company endpoints
        │     └── PeopleController          -- Contact endpoints
        ├── Guards
        │     └── CrmSyncGuard             -- Feature-flag guard
        ├── Decorators
        │     └── @CrmSync()               -- Metadata decorator
        ├── Types
        │     ├── twenty-crm.types.ts       -- CRM entity interfaces
        │     └── mapping.types.ts          -- Entity mapping interfaces
        └── Utils
              ├── mapping.utils.ts          -- Field transformation utilities
              └── retry.utils.ts            -- Retry with exponential backoff
```

## Module Registration

`TwentyCrmModule` is a **global dynamic module** that supports two registration patterns:

### Static Registration (`forRoot`)

```typescript
TwentyCrmModule.forRoot({
	twentyCrmConfig: {
		apiUrl: 'https://crm.example.com',
		apiKey: 'your-api-key',
		workspaceId: 'workspace-id'
	}
});
```

### Async Registration (`forRootAsync`)

```typescript
TwentyCrmModule.forRootAsync({
	useFactory: (configService: ConfigService) => ({
		twentyCrmConfig: {
			apiUrl: configService.get('TWENTY_CRM_BASE_URL'),
			apiKey: configService.get('TWENTY_CRM_API_KEY')
		}
	}),
	inject: [ConfigService]
});
```

Both methods register the module globally using `@Global()`, making its services available throughout the application without additional imports.

## Configuration

### CrmConfigService

The `CrmConfigService` reads all configuration from environment variables:

| Environment Variable        | Type     | Default | Description                     |
| --------------------------- | -------- | ------- | ------------------------------- |
| `TWENTY_CRM_BASE_URL`       | `string` | --      | Twenty CRM API base URL         |
| `TWENTY_CRM_API_KEY`        | `string` | --      | API key for authentication      |
| `TWENTY_CRM_WORKSPACE_ID`   | `string` | --      | Workspace identifier            |
| `TWENTY_CRM_TIMEOUT_MS`     | `number` | `30000` | Request timeout in milliseconds |
| `TWENTY_CRM_MAX_RETRIES`    | `number` | `3`     | Maximum retry attempts          |
| `TWENTY_CRM_RETRY_DELAY_MS` | `number` | `1000`  | Base delay between retries      |

### Feature Detection

```typescript
// Check if integration is properly configured
const isEnabled = crmConfigService.isEnabled;
// Returns true only if apiUrl, apiKey, AND workspaceId are all set

// Validate config throws if missing required vars
crmConfigService.validateConfig();
```

## Services

### TwentyCrmService (HTTP Client)

The core HTTP client for all Twenty CRM API interactions. It handles:

- Bearer token authentication via `Authorization` header
- Workspace scoping via `X-Workspace-Id` header
- Automatic error mapping to NestJS `HttpException`
- Structured logging for all requests

```typescript
// Generic request method
async makeRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    data?: any,
    params?: any,
    schema?: boolean,  // Use metadata API endpoint
): Promise<T>
```

The service exposes two base URLs:

- **REST API**: `{apiUrl}/rest{endpoint}` -- for data operations
- **Metadata API**: `{apiUrl}/rest/metadata{endpoint}` -- for schema operations (when `schema: true`)

### ClientService (CRUD Operations)

High-level service wrapping `TwentyCrmService` for typed entity operations:

| Method                    | HTTP   | Endpoint         | Entity                 |
| ------------------------- | ------ | ---------------- | ---------------------- |
| `createCompany(data)`     | POST   | `/companies`     | `TwentyOrganization`   |
| `getCompany(id)`          | GET    | `/companies/:id` | `TwentyOrganization`   |
| `getCompanies()`          | GET    | `/companies`     | `TwentyOrganization[]` |
| `updateCompany(id, data)` | PUT    | `/companies/:id` | `TwentyOrganization`   |
| `deleteCompany(id)`       | DELETE | `/companies/:id` | `void`                 |
| `createContact(data)`     | POST   | `/contacts`      | `TwentyContact`        |
| `getContact(id)`          | GET    | `/contacts/:id`  | `TwentyContact`        |
| `getContacts()`           | GET    | `/contacts`      | `TwentyContact[]`      |
| `updateContact(id, data)` | PUT    | `/contacts/:id`  | `TwentyContact`        |
| `deleteContact(id)`       | DELETE | `/contacts/:id`  | `void`                 |
| `createDeal(data)`        | POST   | `/deals`         | `TwentyDeal`           |
| `getDeal(id)`             | GET    | `/deals/:id`     | `TwentyDeal`           |
| `getDeals()`              | GET    | `/deals`         | `TwentyDeal[]`         |
| `updateDeal(id, data)`    | PUT    | `/deals/:id`     | `TwentyDeal`           |
| `deleteDeal(id)`          | DELETE | `/deals/:id`     | `void`                 |
| `createProduct(data)`     | POST   | `/products`      | `TwentyProduct`        |
| `getProduct(id)`          | GET    | `/products/:id`  | `TwentyProduct`        |
| `getProducts()`           | GET    | `/products`      | `TwentyProduct[]`      |
| `updateProduct(id, data)` | PUT    | `/products/:id`  | `TwentyProduct`        |
| `deleteProduct(id)`       | DELETE | `/products/:id`  | `void`                 |

### CrmTenantService (Multi-Tenancy)

Manages tenant context resolution for multi-tenant CRM operations:

```typescript
// Resolve tenant from directory or global context
const context = crmTenantService.resolveTenantContext(
	directoryId, // Optional: creates "directory_{id}" tenant
	userId, // Optional: for audit context
	globalTenantId // Optional: fallback to "global_everworks"
);

// Get tenant-specific API prefix
const prefix = crmTenantService.getTenantEndpointPrefix(context);
// Returns: "/tenants/directory_abc123"
```

## Controllers

### CompaniesController

Route: `api/twenty-crm/companies` (JWT-protected)

| Method        | Route              | Description                |
| ------------- | ------------------ | -------------------------- |
| `GET /`       | List all companies | Returns all organizations  |
| `POST /`      | Create company     | Creates a new organization |
| `PATCH /:id`  | Update company     | Updates organization by ID |
| `DELETE /:id` | Delete company     | Removes organization by ID |

### PeopleController

Handles contact/person CRUD. When creating a contact, only these fields are forwarded:

```typescript
{
	(firstName, lastName, email, phone, companyId, position, avatarUrl);
}
```

## CRM Entity Types

### TwentyOrganization

```typescript
interface TwentyOrganization {
	id?: string;
	name: string;
	domainName?: string;
	address?: string;
	employees?: number;
	linkedinUrl?: string;
	xUrl?: string;
	annualRecurringRevenue?: number;
	idealCustomerProfile?: boolean;
}
```

### TwentyContact

```typescript
interface TwentyContact {
	id?: string;
	firstName?: string;
	lastName?: string;
	email?: string;
	phone?: string;
	companyId?: string;
	position?: string;
	avatarUrl?: string;
}
```

### TwentyDeal

```typescript
interface TwentyDeal {
	id?: string;
	title: string;
	amount?: number;
	currency?: string;
	stage?: string;
	probability?: number;
	companyId?: string;
	personId?: string;
}
```

### TwentyProduct

```typescript
interface TwentyProduct {
	id?: string;
	name: string;
	description?: string;
	price?: number;
	currency?: string;
	category?: string;
}
```

## Guards and Decorators

### CrmSyncGuard

A `CanActivate` guard that blocks requests when the CRM integration is disabled or misconfigured:

```typescript
@UseGuards(CrmSyncGuard)
@Post('sync')
async syncData() { ... }
```

The guard checks `CrmConfigService.isEnabled` and runs `validateConfig()`. If either check fails, the request is blocked with a `false` return (HTTP 403).

### @CrmSync Decorator

A metadata decorator for marking routes that require CRM sync:

```typescript
@CrmSync()       // enabled = true (default)
@CrmSync(false)  // disabled
```

Sets the `crm_sync` metadata key, which can be read by guards or interceptors.

## Retry Utilities

The `RetryUtils` class provides resilient API communication:

```typescript
// Retry with exponential backoff
const result = await RetryUtils.withRetry(
	() => apiCall(),
	3, // maxAttempts
	1000, // delayMs
	2 // backoffMultiplier
);

// Check if an error is retryable
RetryUtils.isRetryableError(error);
// true for: ECONNRESET, ETIMEDOUT, ENOTFOUND, 5xx, 429

// Calculate delay with jitter (prevents thundering herd)
const delay = RetryUtils.calculateRetryDelay(1000, attempt, 2, 30000);
```

## Entity Mapping

The mapping system (`mapping.types.ts`) defines how Ever Works entities map to Twenty CRM entities:

| Ever Works Entity  | Twenty CRM Entity    | Key Mapping                                      |
| ------------------ | -------------------- | ------------------------------------------------ |
| `EverWorksCompany` | `TwentyOrganization` | `website` -> `domainName`, `size` -> `employees` |
| `EverWorksClient`  | `TwentyContact`      | Direct field mapping                             |
| `EverWorksItem`    | `TwentyProduct`      | Direct field mapping                             |

Field mappings support custom transforms, required field validation, and detailed transformation logging.

## Source Files

| File                                                                    | Purpose                   |
| ----------------------------------------------------------------------- | ------------------------- |
| `apps/api/src/integrations/index.ts`                                    | Module barrel export      |
| `apps/api/src/integrations/twenty-crm/twenty-crm.module.ts`             | Dynamic module definition |
| `apps/api/src/integrations/twenty-crm/config/crm-config.service.ts`     | Configuration service     |
| `apps/api/src/integrations/twenty-crm/services/twenty-crm.service.ts`   | HTTP client               |
| `apps/api/src/integrations/twenty-crm/services/client.service.ts`       | CRUD operations           |
| `apps/api/src/integrations/twenty-crm/services/crm-tenant.service.ts`   | Multi-tenant context      |
| `apps/api/src/integrations/twenty-crm/controllers/companies.service.ts` | Companies controller      |
| `apps/api/src/integrations/twenty-crm/controllers/people.controler.ts`  | People controller         |
| `apps/api/src/integrations/twenty-crm/guards/crm-sync.guard.ts`         | Feature gate guard        |
| `apps/api/src/integrations/twenty-crm/decorators/crm-sync.decorator.ts` | Metadata decorator        |
| `apps/api/src/integrations/twenty-crm/types/twenty-crm.types.ts`        | CRM type definitions      |
| `apps/api/src/integrations/twenty-crm/types/mapping.types.ts`           | Mapping type definitions  |
| `apps/api/src/integrations/twenty-crm/utils/retry.utils.ts`             | Retry utilities           |
