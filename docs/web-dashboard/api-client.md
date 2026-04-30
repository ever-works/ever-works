---
id: api-client
title: API Client Layer
sidebar_label: API Client
sidebar_position: 8
---

# API Client Layer

The web dashboard communicates with the NestJS backend API through a server-side API client layer in `src/lib/api/`. This layer runs exclusively on the server (using `import 'server-only'`) and provides typed functions for every API endpoint. Server actions call these client functions, never making API calls directly.

## File Organization

```
src/lib/api/
  index.ts                  # Re-exports all API modules
  server-api.ts             # Core fetch utilities (serverFetch, serverMutation)
  auth.ts                   # Authentication endpoints
  directory.ts              # Directory CRUD, import, schedule, settings
  items-generator.ts        # Item generation, submission, extraction
  ai-conversation.ts        # AI chat streaming endpoint
  website.ts                # Website repository management
  health.ts                 # Health check endpoint
  members.ts                # Directory member management
  notifications.ts          # Notification endpoints
  plugins.ts                # Plugin management and settings
  settings.ts               # User settings endpoints
  enums.ts                  # Shared enum definitions
  types.ts                  # Shared type definitions
  types-only.ts             # Re-exported types (no runtime code)
  plugins-capabilities/     # Plugin capability-specific APIs
    screenshot.ts           # Screenshot plugin API
    deploy.ts               # Deployment plugin API
    git-providers.ts        # Git provider plugin API
    oauth.ts                # OAuth plugin API
```

## Core Utilities

### serverFetch

**File**: `src/lib/api/server-api.ts`

The foundation for all API calls. Handles authentication, error parsing, and response processing.

```typescript
async function serverFetch<T>(
    endpoint: string,
    options?: ServerFetchOptions
): Promise<T>
```

**Request Pipeline**:
1. Reads the auth access token from cookies via `getAuthAccessCookie()`
2. Determines the frontend URL from request headers (`x-forwarded-host`, `host`) for the `X-Frontend-URL` header
3. Constructs headers: `Content-Type: application/json`, `Authorization: Bearer {token}`, `X-Frontend-URL`
4. Sends the request to `${API_URL}${endpoint}` with `cache: 'no-store'` and `revalidate: 0`
5. If `rawResponse: true`, returns the raw `Response` object (used for streaming)
6. Parses the JSON response, or falls back to text

**Error Handling**:

| Status | Behavior |
|--------|----------|
| 401 | Throws with `t('unauthorizedLogin')` or API error message |
| 403 | Throws with `t('forbidden')` or API error message |
| Other 4xx/5xx | Parses error from `message`, `error.message`, or `error` field in response body |

Error messages are extracted from multiple response formats to handle different API error shapes:
```typescript
// Format 1: { message: "..." } or { message: ["err1", "err2"] }
// Format 2: { error: { message: "..." } }
// Format 3: { error: "..." }
// Format 4: { message: "...", errors: ["detail1", "detail2"] }
```

### serverMutation

A convenience wrapper for write operations:

```typescript
async function serverMutation<T>({
    endpoint: string,
    data: any,
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    wrapInData: boolean,
    headers?: Record<string, string>,
}): Promise<T>
```

When `wrapInData` is true, the data is wrapped as `{ data: ... }` in the request body.

### handleServerError

A utility for re-throwing errors with translated messages:

```typescript
async function handleServerError(error: unknown): Promise<never>
```

## Items Generator API

**File**: `src/lib/api/items-generator.ts`

Provides the client for all generation-related endpoints.

| Method | Endpoint | HTTP | Description |
|--------|----------|------|-------------|
| `generate` | `/directories/{id}/generate` | POST | Starts item generation |
| `update` | `/directories/{id}/update` | POST | Starts item update generation |
| `submitItem` | `/directories/{id}/submit-item` | POST | Submits a new item |
| `removeItem` | `/directories/{id}/remove-item` | POST | Removes an item |
| `updateItem` | `/directories/{id}/update-item` | POST | Updates item metadata |
| `extractItemDetails` | `/extract-item-details` | POST | AI-extracts details from URL |
| `regenerateMarkdown` | `/directories/{id}/regenerate-markdown` | POST | Regenerates all markdown |
| `getFormSchema` | `/directories/{id}/generator-form` | GET | Gets directory form schema |
| `getFormSchemaGlobal` | `/generator-form` | GET | Gets global form schema |

**Type Re-exports**: The file re-exports key types from `@ever-works/plugin` and `@ever-works/contracts/api`:

```typescript
export type {
    PluginIcon, ProviderOption, GeneratorFormSchema,
    FormSchemaProvidersType, ProviderSelectionState,
    SelectableProviderCategory, ProviderCategoryKey,
} from '@ever-works/plugin';

export type {
    ProvidersDto, CreateItemsGeneratorDto, UpdateItemsGeneratorDto,
    SubmitItemDto, RemoveItemDto, UpdateItemDto, ExtractItemDetailsDto,
} from '@ever-works/contracts/api';
```

**Response Types**:

```typescript
interface ItemsGeneratorResponse {
    id: string;
    slug: string;
    status: string;
    message?: string;
}

interface ItemResponse {
    status: 'success' | 'error' | 'pending';
    slug: string;
    item_name: string;
    item_slug?: string;
    message: string;
    pr_number?: number;
    pr_url?: string;
    auto_merged?: boolean;
    item?: ItemData;
}
```

## Enums

**File**: `src/lib/api/enums.ts`

Centralizes enum definitions, re-exporting from `@ever-works/contracts/api` and defining web-specific enums:

```typescript
// From @ever-works/contracts/api
export { GenerationMethod, WebsiteRepositoryCreationMethod } from '@ever-works/contracts/api';
export { GenerateStatusType, DirectoryScheduleCadence,
         DirectoryScheduleStatus, DirectoryScheduleBillingMode } from '@ever-works/contracts/api';

// Web-specific
export enum OAuthProvider {
    GITHUB = 'github',
    GOOGLE = 'google',
}

export enum DirectoryMemberRole {
    OWNER = 'owner',      // Reserved for creator, not assignable
    MANAGER = 'manager',  // Can edit directory and manage members
    EDITOR = 'editor',    // Can edit content, cannot manage members
    VIEWER = 'viewer',    // Read-only access
}

export const ASSIGNABLE_MEMBER_ROLES = [
    DirectoryMemberRole.MANAGER,
    DirectoryMemberRole.EDITOR,
    DirectoryMemberRole.VIEWER,
] as const;
```

## Plugin Capabilities APIs

The `plugins-capabilities/` directory contains API clients for plugin-specific features:

### Screenshot API (`screenshot.ts`)

| Method | Description |
|--------|-------------|
| `checkAvailability()` | Checks if any screenshot plugin is configured |
| `getScreenshotUrl(options)` | Gets a screenshot URL for a given website URL |

### Deploy API (`deploy.ts`)

| Method | Description |
|--------|-------------|
| `deploy(directoryId, options)` | Triggers a deployment |
| `getDeploymentTeams()` | Lists deployment provider teams |
| `getTeamsForDirectory(directoryId)` | Lists teams using directory's plugin token |
| `lookupExistingDeployment(directoryId)` | Checks for existing deployments |

### Git Providers API (`git-providers.ts`)

| Method | Description |
|--------|-------------|
| `checkConnection(providerId)` | Checks if a git provider is connected |
| `getOrganizations(providerId)` | Lists user's organizations on the provider |

### OAuth API (`oauth.ts`)

| Method | Description |
|--------|-------------|
| `getConnectUrl(providerId, callbackUrl, state, forceConsent?)` | Gets OAuth authorization URL |
| `disconnect(providerId)` | Disconnects an OAuth provider |

## Request/Response Patterns

### Standard API Response

Most API responses follow this structure:

```typescript
interface APIResponse<T = unknown> {
    status: 'success' | 'error';
    message?: string;
    data?: T;
}
```

### Authentication Flow

Every request includes the JWT access token from the cookie:

```
Authorization: Bearer <access_token>
```

The token is read from cookies using `getAuthAccessCookie()` which runs in the server context. If no token exists, the request proceeds without authentication (for public endpoints).

### Caching Strategy

All API requests use `cache: 'no-store'` and `revalidate: 0` to ensure fresh data. Cache invalidation is handled at the page level via `revalidatePath()` in server actions rather than at the API fetch level.

### Error Propagation

Errors flow through three layers:

```
API Response (4xx/5xx)
  -> serverFetch throws Error with parsed message
    -> Server Action catches, returns { success: false, error: message }
      -> Client component reads result and shows toast/inline error
```

This pattern ensures errors never bubble up as unhandled exceptions in the client, and all error messages are user-friendly (translated via `next-intl` where possible).

## Index Re-exports

**File**: `src/lib/api/index.ts`

The index file provides a single import point for all API modules:

```typescript
export * from './auth';
export * from './directory';
export * from './items-generator';
export * from './website';
export * from './server-api';
export * from './ai-conversation';
export * from './settings';
export * from './health';
export * from './members';
export * from './plugins';
export * from './plugins-capabilities/screenshot';
export * from './plugins-capabilities/deploy';
export * from './plugins-capabilities/git-providers';
export * from './plugins-capabilities/oauth';
export * from './types';
```

Server actions import from this index: `import { directoryAPI, itemsGeneratorAPI } from '@/lib/api'`.
