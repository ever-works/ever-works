---
id: twenty-crm
title: Twenty CRM Integration
sidebar_label: Twenty CRM
sidebar_position: 12
---

# Twenty CRM Integration

The Twenty CRM module provides a REST client for integrating with [Twenty](https://twenty.com), an open-source CRM. It supports CRUD operations on companies, contacts, products, and deals, along with entity mapping utilities and multi-tenant context resolution.

## Architecture

```
apps/api/src/integrations/twenty-crm/
  twenty-crm.module.ts                # Global module with forRoot()/forRootAsync()
  config/
    crm-config.service.ts             # Environment-based configuration
  services/
    twenty-crm.service.ts             # Base REST client (HTTP methods, auth, errors)
    client.service.ts                 # Entity-level CRUD operations
    crm-tenant.service.ts             # Multi-tenant context resolution
  controllers/
    companies.service.ts              # CompaniesController (REST endpoints)
  types/
    twenty-crm.types.ts               # CRM entity interfaces
    mapping.types.ts                  # Ever Works entity interfaces
  utils/
    mapping.utils.ts                  # Entity mapping functions
    retry.utils.ts                    # Retry with exponential backoff
```

## Configuration

The module reads configuration from environment variables via `CrmConfigService`:

| Environment Variable        | Default | Description                      |
| --------------------------- | ------- | -------------------------------- |
| `TWENTY_CRM_BASE_URL`       | --      | Twenty CRM API base URL          |
| `TWENTY_CRM_API_KEY`        | --      | API key for authentication       |
| `TWENTY_CRM_WORKSPACE_ID`   | --      | Workspace identifier             |
| `TWENTY_CRM_TIMEOUT_MS`     | `30000` | Request timeout in milliseconds  |
| `TWENTY_CRM_MAX_RETRIES`    | `3`     | Maximum retry attempts           |
| `TWENTY_CRM_RETRY_DELAY_MS` | `1000`  | Base retry delay in milliseconds |

The `isEnabled` getter returns `true` only when all three required variables (`BASE_URL`, `API_KEY`, `WORKSPACE_ID`) are set.

## Base REST Client

`TwentyCrmService` provides a generic `makeRequest<T>()` method that handles all HTTP communication:

- **Authentication**: Bearer token via `Authorization` header
- **Workspace**: `X-Workspace-Id` header on every request
- **Base URLs**: `/rest` for entity operations, `/rest/metadata` for schema operations
- **Error handling**: Maps Twenty CRM error responses to NestJS `HttpException` with status codes and details

## Entity CRUD Operations

`ClientService` wraps `TwentyCrmService` with typed methods for each entity:

| Entity        | Create          | Read (one)   | Read (all)     | Update          | Delete          |
| ------------- | --------------- | ------------ | -------------- | --------------- | --------------- |
| **Companies** | `createCompany` | `getCompany` | `getCompanies` | `updateCompany` | `deleteCompany` |
| **Contacts**  | `createContact` | `getContact` | `getContacts`  | `updateContact` | `deleteContact` |
| **Deals**     | `createDeal`    | `getDeal`    | `getDeals`     | `updateDeal`    | `deleteDeal`    |
| **Products**  | `createProduct` | `getProduct` | `getProducts`  | `updateProduct` | `deleteProduct` |

## CRM Entity Types

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

### TwentyOrganization

```typescript
interface TwentyOrganization {
	id?: string;
	name: string;
	domainName?: string;
	address?: string;
	employees?: number;
	linkedinUrl?: string;
	annualRecurringRevenue?: number;
	idealCustomerProfile?: boolean;
}
```

### TwentyProduct / TwentyDeal

Products have `name`, `description`, `price`, `currency`, and `category`. Deals have `title`, `amount`, `currency`, `stage`, `probability`, `companyId`, and `personId`.

## Entity Mapping

`MappingUtils` provides static methods to convert between Ever Works entities and Twenty CRM entities:

| Method                       | From               | To                   |
| ---------------------------- | ------------------ | -------------------- |
| `mapClientToContact()`       | `EverWorksClient`  | `TwentyContact`      |
| `mapCompanyToOrganization()` | `EverWorksCompany` | `TwentyOrganization` |
| `mapItemToProduct()`         | `EverWorksItem`    | `TwentyProduct`      |
| `mapItemToDeal()`            | `EverWorksItem`    | `TwentyDeal`         |

Validation helpers (`validateContactData`, `validateOrganizationData`, `validateProductData`, `validateDealData`) return arrays of error messages for missing required fields.

## Multi-Tenant Support

`CrmTenantService` resolves tenant context (`tenantId`, `directoryId`, `userId`) for operations that need workspace isolation.

## Retry Utilities

`RetryUtils` provides `withRetry()` with exponential backoff and jitter. The `isRetryableError()` method identifies transient errors (network timeouts, 5xx status codes) that are safe to retry.

## Module Registration

```typescript
// Static configuration
TwentyCrmModule.forRoot({
	twentyCrmConfig: { apiKey: '...', apiUrl: '...', workspaceId: '...' }
});

// Async configuration
TwentyCrmModule.forRootAsync({
	useFactory: (configService) => configService.getCrmConfig(),
	inject: [ConfigService]
});
```

The module is decorated with `@Global()`, making `TwentyCrmService`, `ClientService`, `CrmTenantService`, and `CrmConfigService` available application-wide.
