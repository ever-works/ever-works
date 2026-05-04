---
id: plugin-capabilities
title: Plugin Capabilities API
sidebar_label: Plugin Capabilities
sidebar_position: 11
---

# Plugin Capabilities API

The plugin capabilities API provides REST endpoints for four cross-cutting capabilities that are implemented through the plugin system: **Deploy**, **Git Provider**, **OAuth**, and **Screenshot**. Each capability is backed by one or more plugins and accessed through facade services.

## Architecture

```
apps/api/src/plugins-capabilities/
  deploy/
    deploy.controller.ts              # Deployment endpoints
    deploy.service.ts                 # Deployment orchestration
    dto/deploy.dto.ts                 # Single deploy DTOs
    dto/batch-deploy.dto.ts           # Batch deploy DTOs
    tasks/deployment-verifier.service.ts  # Polls deployment status
  git-provider/
    git-provider.controller.ts        # Git provider endpoints
    git-provider.service.ts           # Connection and listing logic
  oauth/
    oauth.controller.ts               # OAuth flow endpoints
    oauth.service.ts                  # State management and token exchange
  screenshot/
    screenshot.controller.ts          # Screenshot capture endpoints
    dto/screenshot.dto.ts             # Capture options DTO
```

All endpoints require JWT authentication.

## Deploy Capability

Base path: `/api/deploy`

### GET `/api/deploy/providers`

List available deployment providers with their enabled status.

### GET `/api/deploy/providers/:providerId/configured`

Check if the user has configured a specific deployment provider. Returns `configured`, `available`, and `enabled` flags.

### POST `/api/deploy/works/:id`

Deploy a work to its configured provider. The service validates the deploy token, enables GitHub Actions workflows, sets repository secrets (`DEPLOY_TOKEN`, `DATA_REPOSITORY`, `CRON_SECRET`, and provider-specific tokens), then dispatches the deployment workflow with retry logic.

| Body Parameter | Type   | Description                    |
| -------------- | ------ | ------------------------------ |
| `teamScope`    | string | Optional deployment team/scope |

The deployment flow:

1. Validates deploy token via `DeployFacadeService`
2. Retrieves git access token for the work owner
3. Sets required and optional GitHub Actions secrets
4. Dispatches workflow (`deploy_vercel.yaml` or `deploy_prod.yaml`)
5. On failure, updates the repository and retries
6. Starts background verification polling

### POST `/api/deploy/validate-token`

Check if the user has a valid deployment provider available.

### POST `/api/deploy/teams`

Get deployment teams from the user's deployment provider.

### POST `/api/deploy/works/:id/teams`

Get deployment teams for a specific work. Uses the work owner's credentials if the requesting user is a collaborator.

### POST `/api/deploy/works/:id/check`

Check deployment capability for a work. Returns `canDeploy`, `isShared`, `ownerHasToken`, and `userHasToken`.

### POST `/api/deploy/works/:id/lookup`

Look up an existing deployment for a work. Returns the `website` URL and `deploymentState`.

### POST `/api/deploy/batch`

Deploy multiple works at once. Processes in batches of 5 concurrently with a 2-second delay between batches. Returns per-work results with `status` (`success` | `partial` | `error`).

### Deployment Verification

`DeploymentVerifierService` polls deployment status every 10 seconds with a 13-minute timeout. Deployment states: `BUILDING`, `ERROR`, `INITIALIZING`, `QUEUED`, `READY`, `CANCELED`, `TIMEOUT`.

## Git Provider Capability

Base path: `/api/git-providers`

### GET `/api/git-providers`

List available git providers with overall configuration status.

### GET `/api/git-providers/:providerId/connection`

Check connection status for a git provider. Returns whether the provider is connected via OAuth or personal access token.

### GET `/api/git-providers/:providerId/organizations`

List organizations accessible through the git provider.

### GET `/api/git-providers/:providerId/repositories`

List repositories from the git provider.

| Query Parameter | Type   | Description      |
| --------------- | ------ | ---------------- |
| `page`          | number | Page number      |
| `perPage`       | number | Results per page |

### GET `/api/git-providers/:providerId/user`

Get the authenticated user's information from the git provider.

## OAuth Capability

Base path: `/api/oauth`

### GET `/api/oauth/providers`

List available OAuth providers with configuration status.

### GET `/api/oauth/:providerId/connection`

Check OAuth connection status for a provider.

### GET `/api/oauth/:providerId/connect/url`

Get the OAuth authorization URL to initiate the connection flow.

| Query Parameter | Type    | Description                           |
| --------------- | ------- | ------------------------------------- |
| `callbackUrl`   | string  | Custom callback URL                   |
| `state`         | string  | OAuth state parameter                 |
| `forceConsent`  | boolean | Force consent screen (`true`/`false`) |

### GET `/api/oauth/:providerId/callback/plugins`

OAuth callback handler. Receives the authorization `code` and optional `state`, exchanges them for an access token, and stores the connection. State tokens expire after 10 minutes.

### GET `/api/oauth/:providerId/user`

Get user information from the connected OAuth provider.

### DELETE `/api/oauth/:providerId`

Disconnect an OAuth provider. Removes stored tokens and returns `204 No Content`.

## Screenshot Capability

Base path: `/api/screenshot`

### GET `/api/screenshot/check-availability`

Check if a screenshot provider is available and enabled.

### POST `/api/screenshot/capture`

Capture a screenshot and return the result. Returns `imageUrl`, `cacheUrl`, and optionally `imageBase64`.

| Body Parameter       | Type    | Default | Constraints          | Description                  |
| -------------------- | ------- | ------- | -------------------- | ---------------------------- |
| `url`                | string  | --      | Required, valid URL  | Page URL to capture          |
| `viewportWidth`      | number  | --      | 320 - 3840           | Viewport width in pixels     |
| `viewportHeight`     | number  | --      | 240 - 2160           | Viewport height in pixels    |
| `format`             | string  | `png`   | `png`, `jpg`, `webp` | Image output format          |
| `fullPage`           | boolean | `false` | --                   | Capture full scrollable page |
| `delay`              | number  | --      | 0 - 10000            | Delay in ms before capture   |
| `blockAds`           | boolean | `false` | --                   | Block advertisements         |
| `blockTrackers`      | boolean | `false` | --                   | Block tracking scripts       |
| `blockCookieBanners` | boolean | `false` | --                   | Block cookie consent banners |

### POST `/api/screenshot/get-url`

Generate a screenshot URL without capturing. Accepts the same parameters as `/capture`.
