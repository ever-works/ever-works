# Plugin System Scope Resolution — Audit & Fixes

## Overview

The plugin system supports a 4-level settings hierarchy (`directory > user > admin > env > default`) and scope-aware plugin resolution (`directory > user > autoEnable`). The pipeline system correctly handles this via "bound facades" in `step-pipeline-executor.service.ts`, but **direct service callers outside the pipeline** were bypassing scoping by not passing `userId`/`directoryId`.

This document describes the issues found and the fixes applied.

## Issues Fixed

### Issue 1 (CRITICAL): AwesomeReadmeParserService — scope not threaded

**Problem:** The `parseReadme()` method's `facadeOptions` parameter was threaded through correctly, but the `syncFromAwesomeReadme()` caller in `DirectoryImportService` was not passing scope.

**Fix:** `directory-import.service.ts` — Pass `{ userId: user.id, directoryId: directory.id }` to `parseReadme()` in the sync flow.

**Files modified:**

- `packages/agent/src/services/directory-import.service.ts`

### Issue 2 (CRITICAL): DirectoryDetailService — askJson missing userId

**Problem:** When generating directory details via AI, the user's AI provider preference and API key were ignored because `userId` was not passed to `askJson()`.

**Fix:** Added `{ userId: user.id }` as the 4th argument to `askJson()`. No `directoryId` is available at this point (directory not yet created), which is correct.

**File modified:**

- `packages/agent/src/services/directory-detail.service.ts`

### Issue 3 (MEDIUM): listPluginModels ignores user credentials

**Problem:** The model dropdown in plugin settings used `plugin.listModels()` directly, bypassing the settings hierarchy. Users who configured their own API keys would see models from admin/env credentials instead.

**Fix:** Replaced direct `plugin.listModels()` call with `aiFacade.getAvailableModels({ providerOverride: pluginId, userId })`, which resolves credentials through the full settings hierarchy.

**Files modified:**

- `apps/api/src/plugins/plugins.service.ts` — Inject `AiFacadeService`, delegate to facade
- `apps/api/src/plugins/plugins.module.ts` — Import `FacadesModule`

### Issue 4 (MEDIUM): Directory plugin endpoints lack ownership checks

**Problem:** Any authenticated user who knew a `directoryId` could enable/disable plugins and change settings for any directory — a security vulnerability.

**Fix:** Added `DirectoryOwnershipService` injection to `PluginsController` and added ownership checks to all directory-scoped endpoints:

| Route                                       | Guard           |
| ------------------------------------------- | --------------- |
| `GET /api/directories/:directoryId/plugins` | `ensureCanView` |
| `POST .../plugins/:pluginId/enable`         | `ensureCanEdit` |
| `POST .../plugins/:pluginId/disable`        | `ensureCanEdit` |
| `PATCH .../plugins/:pluginId/settings`      | `ensureCanEdit` |
| `POST .../plugins/:pluginId/capability`     | `ensureCanEdit` |

**Files modified:**

- `apps/api/src/plugins/plugins.controller.ts` — Inject service, add checks
- `apps/api/src/plugins/plugins.module.ts` — Import `DirectoryModule`

### Issue 5 (MEDIUM): configurationMode not enforced in API layer

**Problem:** `admin-only` plugins could have their settings modified by regular users through the API. The agent-level `PluginSettingsService` enforces this, but the API layer bypassed it with direct TypeORM writes.

**Fix:** Added `enforceConfigurationMode()` check in:

- `enablePluginForUser()` — when settings are provided
- `updateUserPluginSettings()` — when settings are provided
- `enablePluginForDirectory()` — when settings are provided
- `updateDirectoryPluginSettings()` — when settings are provided

**File modified:**

- `apps/api/src/plugins/plugins.service.ts`

### Issue 6 (LOW): ContentExtractorFacade type-safety gap

**Problem:** `extractContent(url, options?)` accepted `FacadeExtractionOptions` which doesn't include `userId`/`directoryId`. Internally cast to `ExtendedFacadeExtractionOptions`. The compiler wouldn't flag missing scope for future direct callers.

**Fix:** Added explicit `facadeOptions?: BaseFacadeOptions` as 3rd parameter (matching ScreenshotFacade pattern). Updated pipeline binding to use new parameter. Legacy `ExtendedFacadeExtractionOptions` casting still works for backward compatibility.

**Files modified:**

- `packages/agent/src/facades/content-extractor.facade.ts`
- `packages/agent/src/pipeline/step-pipeline-executor.service.ts`

### Issue 7 (LOW): SearchFacade type-safety gap

**Problem:** Same pattern as Issue 6 — scope passed through extended options casting.

**Fix:** Added explicit `facadeOptions?: BaseFacadeOptions` as 3rd parameter. Updated pipeline binding.

**Files modified:**

- `packages/agent/src/facades/search.facade.ts`
- `packages/agent/src/pipeline/step-pipeline-executor.service.ts`

### Issue 8 (LOW): getDefaultProvider directory check ignores user scope

**Problem:** `getDefaultProvider(directoryId?, userId?)` found active plugins by directory capability but only checked global `registered.state === 'enabled'` without verifying user-scoped enable/disable state.

**Fix:** Added `isPluginEnabled(pluginId, directoryId, userId)` check after finding active directory plugin.

**File modified:**

- `packages/agent/src/facades/base.facade.ts`

## Verification

1. `pnpm type-check` — no type errors from signature changes
2. `pnpm test` in `packages/agent` and `apps/api` — no regressions
3. Manual: Import an awesome readme with user-specific AI key — verify user's key is used
4. Manual: Attempt directory plugin endpoint as non-owner — should get 403
5. Manual: Configure user-specific API key — list models — should use user key
