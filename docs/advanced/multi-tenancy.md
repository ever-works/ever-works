---
id: multi-tenancy
title: 'Multi-Tenancy & Isolation'
sidebar_label: 'Multi-Tenancy'
sidebar_position: 8
---

# Multi-Tenancy & Isolation

Ever Works isolates data and configuration at the work level. Each work acts as an independent workspace with its own plugin settings, capability routing, member permissions, and generated content. This page documents the isolation boundaries, role-based access control, and settings scoping that make multi-tenancy work.

**Key sources:**

- `packages/agent/src/services/work-ownership.service.ts` -- Role-based access control
- `packages/agent/src/plugins/entities/work-plugin.entity.ts` -- Per-work plugin configuration
- `packages/agent/src/plugins/services/plugin-settings.service.ts` -- Multi-level settings resolution
- `packages/agent/src/plugins/services/plugin-context-factory.service.ts` -- Scoped plugin contexts

## Architecture

```mermaid
graph TD
    subgraph "Tenant Boundary: Work"
        A["Work A"]
        B["Work B"]
    end

    subgraph "Shared Platform"
        C[Plugin Registry]
        D[AI Providers]
        E[User Accounts]
    end

    subgraph "Per-Work Isolation"
        F["Plugin Settings<br/>(WorkPluginEntity)"]
        G["Capability Routing<br/>(which plugin per capability)"]
        H["Member Roles<br/>(RBAC)"]
        I["Generated Content<br/>(items, categories, tags)"]
        J["Pipeline Checkpoints<br/>(scoped cache keys)"]
    end

    A --> F
    A --> G
    A --> H
    A --> I
    A --> J
    B --> F
    B --> G
    B --> H
    B --> I
    B --> J
    C --> A
    C --> B
    D --> A
    D --> B
    E --> H
```

## Work as Tenant

The work is the primary isolation boundary in Ever Works. Each work:

- Has its own set of items, categories, and tags
- Can override plugin settings at the work level
- Routes capabilities independently (e.g., Work A uses GitHub, Work B uses GitLab)
- Has its own member list with role-based permissions
- Maintains separate pipeline checkpoints

| Aspect                      | Isolation Level | Mechanism                               |
| --------------------------- | --------------- | --------------------------------------- |
| Content (items, categories) | Full            | Foreign key to `workId`            |
| Plugin settings             | Layered         | `WorkPluginEntity` overrides       |
| Capability routing          | Independent     | `activeCapability` per work-plugin |
| Access control              | Per-work   | `WorkOwnershipService` + roles     |
| Cache / checkpoints         | Scoped          | Cache key includes `workId`        |
| Generation history          | Per-work   | Scoped to work                     |

## Role-Based Access Control

### Role Hierarchy

The `WorkOwnershipService` enforces a four-level role hierarchy:

```mermaid
graph BT
    V["VIEWER (1)<br/>Read-only access"] --> E["EDITOR (2)<br/>Content editing"]
    E --> M["MANAGER (3)<br/>Member management"]
    M --> O["OWNER (4)<br/>Full control"]
```

| Role      | Level | Permissions                                  |
| --------- | ----- | -------------------------------------------- |
| `VIEWER`  | 1     | View work content                       |
| `EDITOR`  | 2     | View + edit content, trigger generation      |
| `MANAGER` | 3     | View + edit + manage members                 |
| `OWNER`   | 4     | Full control including deletion and transfer |

### Access Check Methods

```typescript
// Check minimum role requirement
await ownershipService.ensureCanView(workId, userId); // VIEWER+
await ownershipService.ensureCanEdit(workId, userId); // EDITOR+
await ownershipService.ensureCanManageMembers(workId, userId); // MANAGER+
await ownershipService.ensureIsOwner(workId, userId); // OWNER only

// Non-throwing check
const hasAccess = await ownershipService.hasAccess(workId, userId);

// Get role without enforcing
const role = await ownershipService.getUserRole(workId, userId);
```

### Creator Privilege

The work creator always has `OWNER` access, even without an explicit membership record:

```typescript
const isCreator = work.userId === userId;

if (isCreator) {
	return {
		work,
		member: null,
		role: WorkMemberRole.OWNER,
		isCreator: true
	};
}
```

### Access Result

Every access check returns a `WorkAccessResult` with full context:

```typescript
interface WorkAccessResult {
	work: Work; // The work entity
	member: WorkMember | null; // Membership record (null for creator)
	role: WorkMemberRole; // Effective role
	isCreator: boolean; // Whether user is the original creator
}
```

## Settings Isolation

### Five-Level Resolution Hierarchy

Plugin settings resolve through five levels, with higher-priority levels overriding lower ones:

```mermaid
graph TD
    A["1. Work Settings<br/>(WorkPluginEntity)"] --> F[Resolved Value]
    B["2. User Settings<br/>(UserPluginEntity)"] --> F
    C["3. Admin Settings<br/>(PluginEntity)"] --> F
    D["4. Environment Variables<br/>(process.env)"] --> F
    E["5. Plugin Defaults<br/>(schema default)"] --> F

    style A fill:#e8f5e9
    style B fill:#e3f2fd
    style C fill:#fff3e0
    style D fill:#fce4ec
    style E fill:#f3e5f5
```

| Priority    | Source      | Storage                      | Scope         |
| ----------- | ----------- | ---------------------------- | ------------- |
| 1 (highest) | Work   | `work_plugins.settings` | Per work |
| 2           | User        | `user_plugins.settings`      | Per user      |
| 3           | Admin       | `plugins.settings`           | Global        |
| 4           | Environment | `process.env[x-envVar]`      | Server-wide   |
| 5 (lowest)  | Default     | JSON Schema `default`        | Built-in      |

### How Resolution Works

```typescript
// Resolution order: work > user > admin > env > default
async getResolvedSettings(pluginId: string, options?: SettingsResolutionOptions) {
    // 1. Check work settings (if workId provided)
    if (options?.workId && sources.work[key] !== undefined) {
        return { value, source: 'work' };
    }

    // 2. Check user settings (if userId provided)
    if (options?.userId && sources.user[key] !== undefined) {
        return { value, source: 'user' };
    }

    // 3. Check admin settings
    if (sources.admin[key] !== undefined) {
        return { value, source: 'admin' };
    }

    // 4. Check environment variable
    if (envVar && process.env[envVar] !== undefined) {
        return { value: parseEnvValue(process.env[envVar]), source: 'env' };
    }

    // 5. Fall back to default
    return { value: defaultValue, source: 'default' };
}
```

Each resolved setting includes its source and whether it is a fallback:

```typescript
interface ResolvedSetting {
	key: string;
	value: unknown;
	source: 'work' | 'user' | 'admin' | 'env' | 'default';
	isFallback: boolean; // true when source doesn't match setting's intended scope
}
```

### Configuration Modes

Plugins declare how their settings can be managed:

| Mode            | Work Settings | User Settings  | Admin Settings | Use Case                            |
| --------------- | ------------------ | -------------- | -------------- | ----------------------------------- |
| `hybrid`        | Yes                | Yes            | Yes            | Most plugins (OpenRouter, Scrapfly) |
| `user-required` | Yes                | Yes (required) | No             | Per-user API keys (Mistral, Google) |
| `admin-only`    | No                 | No             | Yes            | System-level config                 |

When a plugin is `admin-only`, the settings service rejects user and work level updates:

```typescript
if (configMode === 'admin-only') {
	throw new Error(`Plugin "${pluginId}" is admin-only and cannot be configured by users`);
}
```

### Scope Validation

Settings declare their intended scope via the `x-scope` schema extension. The service validates that updates happen at the correct level:

```typescript
// work-scoped settings can only be set at work level
if (settingScope === 'work' && updateScope !== 'work') {
	violations.push(`Setting "${key}" cannot be updated at "${updateScope}" level`);
}

// user-scoped settings cannot be set at global level
if (settingScope === 'user' && updateScope === 'global') {
	violations.push(`Setting "${key}" cannot be updated at "global" level`);
}
```

## Per-Work Plugin Configuration

The `WorkPluginEntity` stores work-specific plugin overrides:

```typescript
@Entity({ name: 'work_plugins' })
@Unique(['workId', 'pluginId'])
class WorkPluginEntity {
	workId: string; // Which work
	pluginId: string; // Which plugin
	enabled: boolean; // Plugin enabled for this work
	activeCapability: string; // Active capability routing
	settings: Record<string, unknown>; // Work-level settings
	secretSettings: Record<string, unknown>; // Work-level secrets
	metadata: Record<string, unknown>; // Integration state
	priority: number; // Plugin priority in this work
}
```

### Capability Routing

Each work can independently choose which plugin serves each capability:

```mermaid
graph TD
    subgraph "Work A"
        A1["ai-provider: OpenAI"]
        A2["search: Exa"]
        A3["git: GitHub"]
    end

    subgraph "Work B"
        B1["ai-provider: Google Gemini"]
        B2["search: Bright Data"]
        B3["git: GitHub"]
    end

    subgraph "Work C"
        C1["ai-provider: OpenRouter"]
        C2["search: Tavily"]
        C3["git: (none)"]
    end
```

The `activeCapability` field on `WorkPluginEntity` determines which plugin is active for a given capability within a work. Only one plugin can be active per capability per work.

### Secret Isolation

Secrets (API keys, tokens) are stored separately from regular settings and are never included in API responses unless explicitly requested:

| Column           | Content                       | API Response         |
| ---------------- | ----------------------------- | -------------------- |
| `settings`       | Non-sensitive configuration   | Included             |
| `secretSettings` | API keys, tokens, credentials | Masked as `********` |

The settings service strips masked placeholders on write to prevent overwriting real secrets with mask values:

```typescript
if (propSchema?.['x-secret'] && value === MASKED_SECRET_PLACEHOLDER) {
	continue; // Don't save the placeholder
}
```

## Scoped Plugin Contexts

When a plugin executes, it receives a `PluginContext` scoped to the current work and user:

```mermaid
graph TD
    A[Plugin Execution] --> B[PluginContextFactory]
    B --> C["PluginContext"]
    C --> D["Scoped Logger<br/>(Plugin:pluginId)"]
    C --> E["Scoped Cache<br/>(plugin:pluginId: prefix)"]
    C --> F["Scoped Settings<br/>(work > user > admin)"]
    C --> G["Scoped Events<br/>(correlationId enrichment)"]
    C --> H["HTTP Client"]
```

The context factory injects the `userId` and `workId` into the settings resolution, ensuring each plugin operation uses the correct settings for the current scope:

```typescript
const settings = await this.settingsService.getSettings(pluginId, {
	workId: context.workId,
	userId: context.userId,
	includeSecrets: true
});
```

## Cache Key Scoping

All cache keys include the work ID to prevent cross-work data leakage:

| Cache Type          | Key Format                                       | Example                                        |
| ------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Pipeline checkpoint | `pipeline-checkpoint-{workId}-{pipelineId}` | `pipeline-checkpoint-dir123-standard-pipeline` |
| Plugin cache        | `plugin:{pluginId}:{key}`                        | `plugin:openrouter:models-list`                |

Pipeline checkpoints are fully scoped to the work, so resuming a failed generation in one work never affects another.

## Data Isolation Summary

```mermaid
graph LR
    subgraph "Shared (Platform-Wide)"
        A[Plugin Registry]
        B[Plugin Code]
        C[User Accounts]
        D[Admin Settings]
    end

    subgraph "Per-User"
        E[User Plugin Settings]
        F[API Keys]
        G[Notification Preferences]
    end

    subgraph "Per-Work"
        H[Work Plugin Settings]
        I[Work Secrets]
        J[Items / Categories / Tags]
        K[Member Roles]
        L[Generation History]
        M[Pipeline Checkpoints]
        N[Capability Routing]
    end
```

| Boundary  | What Is Isolated           | How                                         |
| --------- | -------------------------- | ------------------------------------------- |
| Platform  | Plugin code, registry      | Shared singleton services                   |
| User      | API keys, user settings    | `UserPluginEntity`, user-scoped resolution  |
| Work | Content, settings, members | `WorkPluginEntity`, foreign keys, RBAC |
| Plugin    | Cache, logger, events      | Namespace-prefixed keys, scoped context     |

## Best Practices

1. **Always pass `workId` and `userId` to settings resolution**: Omitting these causes the service to skip higher-priority settings levels
2. **Use `ensureCanEdit` before mutations**: All content-changing operations should verify at least `EDITOR` role
3. **Never store secrets in `settings`**: Use `secretSettings` for API keys and tokens so they are masked in API responses
4. **Scope cache keys to work**: When writing custom plugins that cache data, include the work ID in cache keys to prevent cross-work leakage
5. **Respect `configurationMode`**: Plugins that declare `admin-only` should not accept user-level or work-level settings overrides
