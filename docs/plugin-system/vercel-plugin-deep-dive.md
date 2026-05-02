---
id: vercel-plugin-deep-dive
title: 'Vercel Plugin Deep Dive'
sidebar_label: 'Vercel Deep Dive'
sidebar_position: 52
---

# Vercel Plugin Deep Dive

## Overview

The Vercel plugin provides deployment capabilities for Ever Works works, publishing generated sites as live websites on Vercel's global CDN. It manages projects, deployments, domains, and team scopes through the official Vercel SDK. Deployments are orchestrated indirectly via GitHub Actions workflow dispatch rather than direct Vercel API uploads.

## Architecture

The plugin implements two interfaces: `IPlugin` and `IDeploymentPlugin`. It delegates all API communication to a single service class:

- **`VercelApiService`** -- wraps the `@vercel/sdk` package to handle token validation, team listing, project management, deployment queries, and domain operations.

```
VercelPlugin
  |-- VercelApiService (@vercel/sdk)
```

The Vercel SDK is dynamically imported inside `createSDK` to keep the module load lightweight. Each API call creates a new SDK instance with the provided bearer token, maintaining a stateless per-request authentication model.

The actual deployment flow is indirect: the platform pushes code to GitHub and triggers a GitHub Actions workflow that runs `vercel deploy`. The Vercel plugin's role is to validate tokens, look up existing deployments, manage project domains, and expose the `VercelApiService` for use by deployment facades.

## Configuration

### Environment Variables

| Variable | Required | Description                                                      |
| -------- | -------- | ---------------------------------------------------------------- |
| N/A      | --       | No environment-variable fallbacks; users provide their own token |

### Settings Schema

```typescript
interface VercelSettings {
	apiToken?: string; // Vercel API token (x-secret, user-scoped, required)
	defaultTeamScope?: string; // Default Vercel team slug for deployments (optional)
}
```

- `configurationMode`: `user-required` -- each user must supply their own Vercel API token.
- `apiToken` is marked `x-secret` and `x-scope: 'user'`.
- The `defaultTeamScope` allows users with Vercel Teams to scope all operations to a specific team.

## Capabilities

| Capability   | Description                                   |
| ------------ | --------------------------------------------- |
| `deployment` | Deploy works as live websites on Vercel |

This plugin is the default for the `deployment` capability (`defaultForCapabilities: ['deployment']`).

## API Reference

### Deployment

| Method                | Signature                                                                | Description                                                        |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `deploy`              | `(config: DeploymentConfig, token: string) => Promise<DeploymentResult>` | Returns a pending placeholder; actual deploy is via GitHub Actions |
| `getDeploymentStatus` | `(deploymentId: string, token: string) => Promise<DeploymentResult>`     | Returns current deployment status                                  |

### Token & User

| Method                 | Signature                                                  | Description                                    |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `validateToken`        | `(token: string) => Promise<boolean>`                      | Validates token by calling the Vercel user API |
| `getAuthenticatedUser` | `(token: string) => Promise<{ username; email? } \| null>` | Returns username and email for the token owner |
| `getTeams`             | `(token: string) => Promise<Array<{ id; slug; name }>>`    | Lists teams accessible to the token            |

### Project Management

| Method                     | Signature                                                                                        | Description                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `listProjects`             | `(token: string) => Promise<DeploymentProject[]>`                                                | Lists projects in the default team scope          |
| `getProject`               | `(projectId: string, token: string) => Promise<DeploymentProject \| null>`                       | Retrieves a specific project                      |
| `lookupExistingDeployment` | `(projectName, token, teamScope?) => Promise<{ found; website?; deploymentState?; projectId? }>` | Searches for an existing deployment across scopes |

### Domain Management

| Method         | Signature                                                             | Description                            |
| -------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `getDomains`   | `(projectId, token, teamScope?) => Promise<DeploymentDomain[]>`       | Lists domains for a project            |
| `addDomain`    | `(projectId, domain, token, teamScope?) => Promise<AddDomainResult>`  | Adds a custom domain                   |
| `removeDomain` | `(projectId, domain, token, teamScope?) => Promise<boolean>`          | Removes a domain                       |
| `verifyDomain` | `(projectId, domain, token, teamScope?) => Promise<DeploymentDomain>` | Triggers DNS verification for a domain |

### Service Access

| Method          | Signature                | Description                                                  |
| --------------- | ------------------------ | ------------------------------------------------------------ |
| `getApiService` | `() => VercelApiService` | Exposes the underlying API service for direct use by facades |

## Implementation Details

### Dynamic SDK Import

The `@vercel/sdk` package is imported dynamically inside `VercelApiService.createSDK()` to avoid loading the full SDK at module evaluation time:

```typescript
async createSDK(token: string): Promise<Vercel> {
  const { Vercel } = await import('@vercel/sdk');
  return new Vercel({ bearerToken: token });
}
```

### Cross-Scope Deployment Lookup

`lookupDeploymentAcrossScopes` iterates over the user's personal account and all teams to find a matching project. For each scope it:

1. Searches projects by name.
2. Fetches project domains, preferring custom domains over `*.vercel.app`.
3. Fetches the latest deployment to determine the current state and URL.

### Vercel Deployment States

The plugin tracks these Vercel deployment states:

```typescript
type VercelDeploymentState = 'BUILDING' | 'ERROR' | 'INITIALIZING' | 'QUEUED' | 'READY' | 'CANCELED' | 'TIMEOUT';
```

### Error Handling in SDK Responses

The Vercel SDK sometimes throws errors that contain valid data in `error.rawValue`. The `getProjects` and `getDeployments` methods catch these and extract the `rawValue.projects` or `rawValue.deployments` arrays as a fallback.

## Usage Examples

```typescript
// Validate a Vercel token
const isValid = await vercelPlugin.validateToken(userToken);

// Look up an existing deployment
const result = await vercelPlugin.lookupExistingDeployment('my-work-site', userToken, 'my-team-slug');
if (result.found) {
	console.log(`Live at: ${result.website}`);
}

// Add a custom domain
const domainResult = await vercelPlugin.addDomain(projectId, 'work.example.com', userToken, teamScope);
if (!domainResult.verified) {
	console.log('DNS verification required:', domainResult.domain.verification);
}

// Verify domain DNS
const verified = await vercelPlugin.verifyDomain(projectId, 'work.example.com', userToken, teamScope);
```

## Rate Limiting & Quotas

- **Vercel API**: Rate limits depend on the user's Vercel plan. The Pro plan allows significantly higher request rates than the Hobby plan.
- **Project listing**: Defaults to fetching up to 100 projects per request (`limit: '100'`).
- **Deployment listing**: Configurable via `options.limit`, defaults to fetching latest deployments.
- The plugin does not implement internal rate-limit tracking or retry logic; errors from the Vercel API propagate directly to callers.

## Error Handling

- **Token validation**: Returns `null` on any error (invalid token, network failure), allowing callers to treat it as a simple boolean check.
- **Team and project listing**: Returns empty arrays on API errors, ensuring the UI can degrade gracefully.
- **SDK rawValue fallback**: Catches errors where the SDK throws but includes valid response data in the error object.
- **Domain operations**: Errors from `addProjectDomain` and `verifyProjectDomain` propagate directly since domain management requires explicit user action.

## Related Plugins

- [GitHub Plugin Deep Dive](./github-plugin-deep-dive) -- the Git provider that triggers Vercel deployments via GitHub Actions.
- [Vercel Plugin](./vercel-plugin) -- overview documentation for the Vercel plugin.
