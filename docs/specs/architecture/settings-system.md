# Architecture: Settings System

**Status**: `Active`
**Last updated**: 2026-05-01
**Audience**: AI agents and engineers extending plugin settings, debugging
secret hygiene, or wiring new scopes.

---

## 1. Purpose

Every Ever Works plugin declares a JSON-Schema-shaped `settingsSchema`.
The settings system turns that schema into a stored, validated,
scoped, redacted, three-tier-resolved configuration surface — without
any plugin needing to know how persistence, redaction, or scope
resolution work.

This spec covers the **resolution algorithm**, **scope model**, **secret
hygiene**, and **environment-variable fallback** that make plugin
settings safe to use across admin, user, and per-work contexts.

## 2. The Three Tiers

Plugin settings can be set at three scopes:

| Scope    | Storage table     | Configured by | Lifetime                  |
| -------- | ----------------- | ------------- | ------------------------- |
| `global` | `plugin_settings` | Admin         | Survives all sessions     |
| `user`   | `user_plugins`    | The user      | Per-user                  |
| `work`   | `work_plugins`    | Work editor   | Per-work (overrides user) |

The **resolution cascade** for a key is, in order of precedence:

1. **Work** — if the call carries a `workId` and the work
   has its own value for the key.
2. **User** — if the call carries a `userId` and the user has their own
   value.
3. **Admin (global)** — the platform-wide default an admin set.
4. **Environment variable** — the value of `x-envVar` from the schema,
   if defined and present in the process env.
5. **Schema default** — the JSON Schema `default` value.
6. **Undefined** — caller must handle the missing value.

The cascade is implemented in `PluginSettingsService.resolve(...)`. It's
the same code path for plugin enablement, settings UI rendering, and
runtime capability calls.

## 3. The Schema Surface

Every plugin's `settingsSchema` is a JSON Schema Draft 7 object with
Ever Works `x-*` extensions. The full extension set is documented in
[Plugin SDK §8](./plugin-sdk.md). The ones that drive the settings system are:

| Extension          | Used by                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `x-secret`         | Storage layer (encryption), redactor, exports                           |
| `x-envVar`         | Resolution cascade step 4                                               |
| `x-scope`          | Hint to the UI; the actual scope is inferred from where the user clicks |
| `x-adminOnly`      | UI filter for `hybrid` plugins                                          |
| `x-hidden`         | UI filter — never rendered                                              |
| `x-showIf`         | Conditional rendering on the form                                       |
| `x-requiredGroups` | "Pick one of these auth modes" validation hint                          |
| `x-widget`         | UI input type (password, textarea, etc.)                                |

`x-secret` is the most consequential. It's the **single hook** the
platform uses to know which fields must be encrypted at rest, redacted in
exports, masked in logs, stripped from MCP responses, and ignored on
GitHub Sync pull. See §7.

## 4. Configuration Modes

A plugin's `configurationMode` (set in its manifest, see
[Plugin SDK §7](./plugin-sdk.md#7-plugin-manifest)) decides which scopes
are even allowed:

| Mode            | Where settings live                               | Notes                                                      |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `admin-only`    | `plugin_settings` only                            | UI hides per-user / per-work editors                       |
| `user-required` | `user_plugins` (and `work_plugins` for overrides) | Users must enter their own creds; admin can't pre-populate |
| `hybrid`        | All three tiers                                   | Admin sets defaults; users / works may override            |

The setting form's "where will this go?" depends on the active page:

- Admin → Plugins → `plugin_settings`.
- User → Plugins → `user_plugins`.
- Work → Plugins → `work_plugins`.

Plugins authored as `user-required` reject admin writes server-side;
`admin-only` plugins reject user writes. This is enforced in
`PluginSettingsService` regardless of UI behaviour.

## 5. Storage Layer

```
plugin_settings              user_plugins              work_plugins
  pluginId   varchar           pluginId   varchar          pluginId   varchar
  enabled    boolean            userId    uuid             workId uuid
  settings   jsonb              enabled   boolean          enabled    boolean
  secrets    jsonb (encrypted)  settings  jsonb            settings   jsonb
                                secrets   jsonb (encrypted) secrets   jsonb (encrypted)
```

Two separate columns — `settings` (plain) and `secrets` (encrypted) —
enable two key behaviours:

1. **Cheap reads of non-secret config** — listing plugins doesn't need to
   decrypt anything.
2. **Single-cell encryption boundary** — the encryption key only needs to
   cover the `secrets` jsonb cell.

Encryption is **AES-256-GCM** keyed off `PLUGIN_SECRETS_ENCRYPTION_KEY`
(64-hex-char). Rotation is supported via `keyId` in the encrypted
envelope; the system reads any registered key, writes only with the
current key.

## 6. Capability Settings vs Plugin Settings

Two flavours of "settings" coexist:

- **Plugin settings** — what `settingsSchema` declares: API keys,
  default models, UI preferences. Bound to a plugin id.
- **Capability settings** — provider-selection bindings: "for this
  work, use plugin `openai` for capability `ai-provider`."
  Bound to `(scope, capability)`.

Capability bindings live in:

- `work_plugins.<capability>` (per-work provider bindings)
- `user_plugins.<capability>` (per-user provider bindings)
- A platform-wide fallback resolved from each plugin's `defaultFor`
  manifest field.

The cascade in [Plugin SDK §11](./plugin-sdk.md#11-provider-selection)
applies to capability resolution. Plugin settings cascade independently
within whatever plugin won the capability resolution.

## 7. Secret Hygiene Boundary

`x-secret` is the **only** declaration a plugin needs to make for the
platform to enforce all of these:

| Boundary              | Behaviour                                                                               |
| --------------------- | --------------------------------------------------------------------------------------- |
| Storage               | Routed to the encrypted `secrets` jsonb column, not `settings`                          |
| API responses         | Stripped before serialisation (the listing endpoints never emit secret values)          |
| Activity log entries  | Never include secret values                                                             |
| Sentry breadcrumbs    | Settings keys with `x-secret` are scrubbed                                              |
| Export / Import       | Real values masked as `MASKED:<first-3>***<last-4>` (or `MASKED:********` for ≤8 chars) |
| GitHub Sync push      | Same masked format                                                                      |
| GitHub Sync pull      | All `x-secret` keys are unconditionally ignored, regardless of file content             |
| MCP server responses  | Response sanitiser strips all secret-like field names as defence in depth               |
| Plugin → plugin calls | Plugin context's settings accessor returns secrets in plaintext only inside the process |

The redactor (`redactSecretsFromSettings(plugin, value)`) consults the
plugin's JSON Schema, not a hardcoded list — adding a new secret to a
plugin is one schema change, no other code edits.

See [`features/data-management/spec`](../features/data-management/spec.md)
for the full export/import/sync contract that flows from this
principle.

## 8. Environment-Variable Fallback

A schema property declaring `x-envVar` plugs that property into the
resolution cascade at step 4:

```ts
apiKey: {
    type: 'string',
    'x-secret': true,
    'x-envVar': 'PLUGIN_OPENAI_API_KEY',
}
```

If no admin / user / work value is set but `process.env.PLUGIN_OPENAI_API_KEY`
is, the resolver returns that value. **Plugins never read `process.env`
themselves** — they read settings, and the resolver consults env-vars
where the schema says it should. This keeps:

- Settings provenance auditable (we know whether a value came from DB or env).
- Env-var allowlisting trivial (the platform only reads vars listed in
  `x-envVar` declarations plus a small infra set).
- Secret rotation simple (rotate env vars on the host without touching
  the DB).

## 9. Setting Resolution API

`PluginSettingsService` is the single read path:

```ts
class PluginSettingsService {
	// Get the entire resolved settings object for a plugin in some scope
	resolve(pluginId: string, scope: { workId?: string; userId?: string }): Promise<PluginSettings>;

	// Get one key with type narrowing
	resolveKey<T>(pluginId: string, key: string, scope: { workId?: string; userId?: string }): Promise<T | undefined>;

	// Get the source of each key for debugging / UI display
	resolveWithSources(pluginId: string, scope): Promise<Record<string, { value: unknown; source: SettingSource }>>;
}
```

`SettingSource` is `'work' | 'user' | 'admin' | 'env' | 'default'`
— useful in the dashboard's settings UI to label each row with
"inherited from admin", "set in this work", etc.

## 10. Settings UI

The Web Dashboard renders a JSON-Schema-driven form per plugin. Custom
widgets are picked from `x-widget` (with sensible fallbacks per JSON
Schema type). `x-showIf` enables conditional fields, `x-requiredGroups`
validates "at least one of these auth modes is set."

Validation runs twice:

1. **Client-side** — Ajv compiled in the browser for instant feedback.
2. **Server-side** — Ajv inside `PluginSettingsService.update`, with
   additional `x-requiredGroups` enforcement.

The UI **never displays an existing secret** — it shows a "set" badge
and a "rotate" button. The platform's `update` endpoint accepts an
opaque "no change" sentinel for secret keys so the UI can submit the
non-secret half of the form without touching the secret.

## 11. Validation Lifecycle

When a user saves settings:

1. **Schema validation** — Ajv against the plugin's `settingsSchema`.
2. **`x-requiredGroups`** — at least one group has all its `fields` set.
3. **Plugin-side `validateConnection()`** — for plugins that implement
   it (most AI providers do), the platform calls into the plugin to
   test the credentials before persisting.
4. **Persistence** — split secrets vs non-secrets, encrypt secrets,
   upsert.
5. **`onSettingsUpdated` hook** — the plugin gets the new resolved
   settings.
6. **Activity log** — entry written with the plugin id and the changed
   keys (never the values).

## 12. Constitution Reconciliation

| Principle                   | How the settings system respects it                                               |
| --------------------------- | --------------------------------------------------------------------------------- |
| I — Plugin-first            | Settings schema is defined by the plugin, not the platform.                       |
| II — Capability-driven      | Capability bindings cascade by the same algorithm.                                |
| III — Source-of-truth repos | Settings are platform-side metadata (access control), not work content.           |
| IV — Trigger.dev            | Resolution is synchronous and inline.                                             |
| V — Forward-only migrations | Settings shape evolution = adding optional schema properties; no breaking change. |
| VI — Tests                  | Per-tier resolution covered by `PluginSettingsService` unit tests + e2e.          |
| VII — Secret hygiene        | This whole feature is the canonical site for Principle VII.                       |
| VIII — Plugin counts        | N/A.                                                                              |
| IX — Behaviour-first        | This spec describes observable resolution behaviour.                              |
| X — Backwards-compat        | Schema can grow; resolution algorithm is stable.                                  |

## 13. References

- Source:
    - `apps/api/src/plugins/services/plugin-settings.service.ts`
    - `apps/api/src/plugins/repositories/plugin-settings.repository.ts`
    - `packages/plugin/src/settings/`
- Related specs:
    - [`plugin-sdk`](./plugin-sdk.md)
    - [`features/plugin-system/spec`](../features/plugin-system/spec.md)
    - [`features/data-management/spec`](../features/data-management/spec.md)
- User docs: [`docs/plugin-system/settings.md`](../../plugin-system/settings.md)
- Constitution VII: [`.specify/memory/constitution.md`](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md)
