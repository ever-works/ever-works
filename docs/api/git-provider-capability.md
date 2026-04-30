---
id: git-provider-capability
title: Git Provider Capability
sidebar_label: Git Provider Capability
sidebar_position: 17
---

# Git Provider Capability

The Git Provider capability exposes REST endpoints for interacting with Git hosting platforms (GitHub, GitLab, etc.) through the plugin system. It provides repository listing, organization discovery, user info retrieval, and connection status checks.

Source: `apps/api/src/plugins-capabilities/git-provider/`

## Architecture

```
GitProviderModule
  ├── GitProviderController     -- REST API endpoints
  ├── GitProviderService        -- Business logic layer
  ├── GitFacadeService          -- Plugin resolution (from @ever-works/agent)
  └── OAuthFacadeService        -- OAuth credential checks
```

```typescript
@Module({
    imports: [FacadesModule, DatabaseModule],
    controllers: [GitProviderController],
    providers: [GitProviderService],
    exports: [GitProviderService],
})
export class GitProviderModule {}
```

## API Endpoints

All endpoints are under `/api/git-providers` and require JWT authentication.

### List Available Providers

```
GET /api/git-providers
Authorization: Bearer <jwt-token>
```

Returns all available Git providers and overall configuration status.

**Response:**

```json
{
    "configured": true,
    "providers": [
        { "id": "github", "name": "GitHub", "enabled": true }
    ]
}
```

### Check Connection

```
GET /api/git-providers/:providerId/connection
Authorization: Bearer <jwt-token>
```

Checks if the current user has a valid connection to the specified Git provider. Returns connection details including authentication method.

**Response (connected):**

```json
{
    "id": "github",
    "name": "GitHub",
    "enabled": true,
    "connected": true,
    "username": "octocat",
    "email": "octocat@example.com",
    "avatarUrl": "https://avatars.githubusercontent.com/...",
    "authMethod": "oauth"
}
```

**Response (disconnected):**

```json
{
    "id": "github",
    "name": "GitHub",
    "enabled": true,
    "connected": false
}
```

### Get Organizations

```
GET /api/git-providers/:providerId/organizations
Authorization: Bearer <jwt-token>
```

Lists organizations the authenticated user belongs to.

**Response:**

```json
{
    "success": true,
    "organizations": [
        {
            "login": "ever-works",
            "name": "Ever Works",
            "avatarUrl": "https://avatars.githubusercontent.com/..."
        }
    ]
}
```

### Get Repositories

```
GET /api/git-providers/:providerId/repositories?page=1&perPage=30
Authorization: Bearer <jwt-token>
```

Lists repositories accessible to the authenticated user with pagination support.

**Query Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `page` | `number` | No | Page number (1-based) |
| `perPage` | `number` | No | Items per page |

**Response:**

```json
{
    "success": true,
    "repositories": [
        {
            "name": "my-repo",
            "fullName": "user/my-repo",
            "private": false,
            "permissions": {
                "admin": true,
                "push": true,
                "pull": true
            }
        }
    ]
}
```

### Get User Info

```
GET /api/git-providers/:providerId/user
Authorization: Bearer <jwt-token>
```

Returns the authenticated user's profile from the Git provider.

**Response:**

```json
{
    "success": true,
    "user": {
        "login": "octocat",
        "name": "The Octocat",
        "email": "octocat@example.com",
        "avatarUrl": "https://avatars.githubusercontent.com/..."
    }
}
```

## GitProviderService

The service layer handles business logic and delegates to facades.

### Authentication Methods

The service supports two authentication methods, detected automatically:

| Method | Priority | Description |
|---|---|---|
| **OAuth** | Checked first | Token obtained via OAuth flow |
| **Personal Access Token (PAT)** | Fallback | Token configured in plugin settings |

```typescript
export type GitAuthMethod = 'oauth' | 'personal-access-token';
```

### Connection Check Flow

```
1. Find provider by ID from GitFacadeService
2. Check OAuth credentials via OAuthFacadeService
3. Check any credentials (OAuth or PAT) via GitFacadeService
4. If credentials exist, fetch user profile
5. Return connection info with detected auth method
```

```typescript
async checkConnection(userId: string, providerId: string): Promise<GitProviderConnectionInfo> {
    const hasOAuthCredentials = await this.oauthFacade.hasValidCredentials(userId, providerId);
    const hasAnyCredentials = await this.gitFacade.hasValidCredentials({ userId, providerId });

    if (!hasAnyCredentials) {
        return { ...provider, connected: false };
    }

    const user = await this.gitFacade.getUser({ userId, providerId });
    return {
        ...provider,
        connected: true,
        username: user.login,
        authMethod: hasOAuthCredentials ? 'oauth' : 'personal-access-token',
    };
}
```

### GitProviderConnectionInfo

The extended provider info returned by connection checks:

```typescript
interface GitProviderConnectionInfo extends GitProviderInfo {
    connected: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
    authMethod?: GitAuthMethod;
}
```

## Plugin Integration

### Git Provider Plugin Types

The service works with these types from `@ever-works/plugin`:

```typescript
// Organization from the Git platform
interface GitOrganization {
    login: string;
    name?: string;
    avatarUrl?: string;
}

// User profile from the Git platform
interface GitUser {
    login: string;
    name?: string;
    email?: string;
    avatarUrl?: string;
}

// Repository with permission details
interface GitRepositoryWithPermissions {
    name: string;
    fullName: string;
    private: boolean;
    permissions: {
        admin: boolean;
        push: boolean;
        pull: boolean;
    };
}
```

### Facade Methods Used

| Facade Method | Purpose |
|---|---|
| `gitFacade.isConfigured()` | Check if any Git provider is available |
| `gitFacade.getAvailableProviders()` | List all registered Git providers |
| `gitFacade.hasValidCredentials(ctx)` | Check if user has any credentials |
| `gitFacade.getUser(ctx)` | Get authenticated user profile |
| `gitFacade.getOrganizations(ctx)` | List user's organizations |
| `gitFacade.listRepositories(ctx, page, perPage)` | List accessible repositories |
| `oauthFacade.hasValidCredentials(userId, providerId)` | Check OAuth-specific credentials |

The context object (`ctx`) always contains `userId` and `providerId`.

## Error Handling

All endpoints (except listing providers) use try-catch with graceful degradation:

```json
{
    "success": false,
    "repositories": [],
    "error": "Failed to fetch repositories"
}
```

This pattern ensures the frontend always receives a consistent response shape, even when the Git provider API is unreachable or credentials are invalid.

## Supported Providers

| Plugin ID | Platform | Capabilities |
|---|---|---|
| `github` | GitHub | Full support: repos, orgs, user, OAuth |

Additional providers can be added by implementing the `IGitProviderPlugin` interface from `@ever-works/plugin`.

## Source Files

| File | Purpose |
|---|---|
| `apps/api/src/plugins-capabilities/git-provider/git-provider.module.ts` | Module definition |
| `apps/api/src/plugins-capabilities/git-provider/git-provider.controller.ts` | REST API endpoints |
| `apps/api/src/plugins-capabilities/git-provider/git-provider.service.ts` | Business logic and facade coordination |
