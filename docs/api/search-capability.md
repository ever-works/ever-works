---
id: search-capability
title: Search Capability
sidebar_label: Search Capability
sidebar_position: 22
---

# Search Capability

The Search capability exposes a single-call web-search API that delegates
to the user's first enabled and fully configured search provider plugin
(Tavily, Brave, Exa, Perplexity, SerpApi, Linkup, Valyu, Firecrawl, Jina,
or BrightData). It is used by the AI conversation surface, the
work-generation pipeline, and any other module that needs ad-hoc web
search without hard-coding a provider.

Source: `apps/api/src/plugins-capabilities/search/`

## Architecture

```
SearchModule
  ├── SearchController          -- REST API endpoints
  ├── SearchFacadeService       -- Plugin resolution (from @ever-works/agent)
  ├── PluginRegistryService     -- Enabled-plugin enumeration
  └── PluginSettingsService     -- Settings cascade reader
```

```typescript
@Module({
    imports: [FacadesModule, PluginsModule, AuthModule],
    controllers: [SearchController]
})
export class SearchModule {}
```

The controller never reaches into a specific search plugin — it asks
`PluginRegistryService.getEnabledPluginsScoped(SEARCH, undefined,
userId)` for the user's enabled list, picks the first one whose required
settings (excluding `x-envVar` and `x-adminOnly` fields) are populated,
and forwards the call to `SearchFacadeService.search` with the resolved
provider id passed via `providerOverride`.

## API Endpoints

All endpoints are under the `/api/search` prefix and require JWT
authentication via the global `AuthSessionGuard`.

### Check Availability

```
GET /api/search/check-availability
Authorization: Bearer <jwt-token>
```

Returns whether the user has at least one fully-configured search
provider, and which one is active.

**Success Response (available):**

```json
{
    "status": "success",
    "available": true,
    "activeProvider": {
        "id": "tavily",
        "name": "Tavily"
    }
}
```

**Success Response (no provider enabled):**

```json
{
    "status": "success",
    "available": false,
    "activeProvider": null,
    "message": "No search provider is enabled. Enable a search plugin (e.g. Tavily, Linkup, Brave, Exa) in settings."
}
```

**Success Response (enabled but unconfigured):**

```json
{
    "status": "success",
    "available": false,
    "activeProvider": null,
    "message": "Search plugins are enabled but none have all required settings configured (e.g. API key)."
}
```

The two unavailable messages are distinct so the UI can render two
different call-to-action prompts.

### Search

```
POST /api/search/
Authorization: Bearer <jwt-token>
Content-Type: application/json
```

Searches the web using the user's first enabled and fully-configured
search provider.

**Request Body (`SearchDto`):**

| Field            | Type       | Required | Validation        | Description                                          |
| ---------------- | ---------- | -------- | ----------------- | ---------------------------------------------------- |
| `query`          | `string`   | Yes      | non-empty string  | Free-text search query                               |
| `maxResults`     | `number`   | No       | `1` ≤ N ≤ `50`    | Cap on the number of results to return               |
| `includeDomains` | `string[]` | No       | array of hostnames | Restrict results to these domains                    |
| `excludeDomains` | `string[]` | No       | array of hostnames | Drop results from these domains                      |

**Example Request:**

```json
{
    "query": "best project management tools",
    "maxResults": 10,
    "includeDomains": ["producthunt.com", "g2.com"],
    "excludeDomains": ["pinterest.com"]
}
```

**Success Response:**

```json
{
    "status": "success",
    "results": [
        {
            "title": "...",
            "url": "...",
            "snippet": "...",
            "score": 0.91
        }
    ],
    "provider": "Tavily"
}
```

The exact result shape depends on the active plugin — see the per-plugin
documentation for the canonical fields.

**Error Response (400):**

When no provider is configured:

```json
{
    "status": "error",
    "message": "No search provider with all required settings configured is available."
}
```

When the facade rejects with `NoProviderError`:

```json
{
    "status": "error",
    "message": "No search provider configured. Enable a search plugin in settings."
}
```

When the upstream provider throws:

```json
{
    "status": "error",
    "message": "<provider error message>"
}
```

When a non-Error rejection occurs:

```json
{
    "status": "error",
    "message": "Search failed"
}
```

## DTO Validation

The `SearchDto` uses `class-validator` decorators:

```typescript
export class SearchDto {
    @IsString()
    @IsNotEmpty()
    query: string;

    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(50)
    maxResults?: number;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    includeDomains?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    excludeDomains?: string[];
}
```

## Provider Resolution

The controller's private `resolveConfiguredProvider(userId)` helper picks
the active provider in three steps:

1. Enumerate all enabled SEARCH-capability plugins for the user via
   `pluginRegistry.getEnabledPluginsScoped(PLUGIN_CAPABILITIES.SEARCH,
   undefined, userId)`. The cascade respects work → user → admin →
   environment.
2. Sort the list with plugins that declare `defaultForCapabilities:
   ['search']` in their manifest first (e.g. Tavily — the canonical
   default). Other plugins keep their registration order.
3. For each plugin in the sorted list, resolve its settings via
   `pluginSettings.getSettings(pluginId, {userId, includeSecrets: true})`
   and run `hasAllRequiredSettings(schema, resolved)`. The first plugin
   that passes the check wins.

`hasAllRequiredSettings` walks the plugin's `settingsSchema.required`
list and treats `undefined`, `null`, or `''` as missing. Fields flagged
`x-envVar` (env-var fallback) or `x-adminOnly` (admin-supplied) are
**skipped** — they are considered always-present from the user's point
of view.

## Supported Providers

| Plugin ID      | Provider     | Required settings                                                                                |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `tavily`       | Tavily       | `apiKey` (env-var fallback `PLUGIN_TAVILY_API_KEY`)                                              |
| `brave`        | Brave Search | `apiKey` (env-var fallback `PLUGIN_BRAVE_API_KEY`)                                               |
| `exa`          | Exa.ai       | `apiKey` (env-var fallback `PLUGIN_EXA_API_KEY`)                                                 |
| `perplexity`   | Perplexity   | `apiKey` (env-var fallback `PLUGIN_PERPLEXITY_API_KEY`)                                          |
| `serpapi`      | SerpApi      | `apiKey` (env-var fallback `PLUGIN_SERPAPI_API_KEY`)                                             |
| `linkup`       | Linkup       | `apiKey` (env-var fallback `PLUGIN_LINKUP_API_KEY`)                                              |
| `valyu`        | Valyu        | `apiKey` (env-var fallback `PLUGIN_VALYU_API_KEY`)                                               |
| `firecrawl`    | Firecrawl    | `apiKey` (env-var fallback `PLUGIN_FIRECRAWL_API_KEY`)                                           |
| `jina`         | Jina AI      | `apiKey` (env-var fallback `PLUGIN_JINA_API_KEY`)                                                |
| `brightdata`   | BrightData   | `apiToken` + `customerId` (env-var fallbacks `PLUGIN_BRIGHTDATA_API_TOKEN`/`PLUGIN_BRIGHTDATA_CUSTOMER_ID`) |

`tavily` is the canonical default — it ships in the platform's
`built-in-plugins.md` catalogue with `defaultForCapabilities:
['search']`. To override, enable any other plugin with `default: true`
in your settings, or pass `providerOverride` from the calling code path
(currently only available to the AI facade — the HTTP controller does
not expose this; see [`plugins-capabilities`
spec](https://github.com/ever-works/ever-works/tree/develop/docs/specs/features/plugins-capabilities)
OQ-4).

## Provider Integration

The controller uses `SearchFacadeService` to execute the search:

```typescript
const results = await this.searchFacade.search(
    dto.query,
    {
        maxResults: dto.maxResults,
        includeDomains: dto.includeDomains,
        excludeDomains: dto.excludeDomains
    },
    {
        userId: auth.userId,
        providerOverride: provider.id
    }
);
```

Passing the resolved provider via `providerOverride` short-circuits the
facade's own resolution step — the controller and the facade always
agree on which plugin runs.

## Error Handling

The controller throws `BadRequestException` in two scenarios:

1. **No configured provider**: when `resolveConfiguredProvider` returns
   `null` BEFORE the facade is even called.
2. **Search execution failed**: when the facade rejects. `NoProviderError`
   is remapped to a friendlier message; all other errors surface their
   `.message` (or coerce to `"Search failed"` for non-Error rejections).

Both cases return the structured envelope:

```json
{
    "status": "error",
    "message": "<descriptive message>"
}
```

## Usage in the Platform

Search is consumed by:

- **AI conversation**: tool-call lookups when the chat assistant needs
  current information.
- **Work generation pipeline**: source discovery during the standard
  pipeline's research steps.
- **Item enrichment**: optional web-search lookups when extracting items
  from URLs.

## Source Files

| File                                                            | Purpose                 |
| --------------------------------------------------------------- | ----------------------- |
| `apps/api/src/plugins-capabilities/search/search.module.ts`     | Module definition       |
| `apps/api/src/plugins-capabilities/search/search.controller.ts` | REST API controller     |
| `apps/api/src/plugins-capabilities/search/dto/search.dto.ts`    | Request validation DTO  |
| `packages/agent/src/facades/search.facade.ts`                   | Plugin-resolving facade |
| `packages/plugins/<id>/`                                        | Per-provider plugin     |
