# Architecture: `agent.yml` manifest schema

**Status**: `Draft`
**Last updated**: 2026-05-25
**Audience**: Engineers implementing `AgentService.create`, `AgentTemplateService.read`, and anyone hand-authoring an `agent.yml` either in `ever-works/agents` repo or in their own `.works/agents/<slug>/` folder.

> Per [QUESTIONS K1](../QUESTIONS-agents-skills-tasks.md#k1--do-you-want-me-to-also-draft-featuresagentsmanifest-schemamd-documenting-the-agentyml-zod-schema-in-detail). Mirrors the structure of `MissionTemplateManifestService` which already shipped a Zod schema for `.works/mission.yml` (PR JJ on develop).

---

## 1. Where this file lives

Every Agent — whether shipped as a template in [`ever-works/agents`](https://github.com/ever-works/agents), authored by a user inside a Mission/Work repo, or created inline at tenant scope — has an `agent.yml` file. Locations:

| Scope        | Path                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Tenant       | DB-inline column `agents.agentYml` (per [ADR-008](../decisions/008-tenant-control-repo-deferred-to-v2.md)).         |
| Mission      | `<missionRepo>/.works/agents/<slug>/agent.yml`                                                                       |
| Idea         | `<missionRepo>/.works/ideas/<ideaId>/agents/<slug>/agent.yml`                                                        |
| Work         | `<workDataRepo>/.works/agents/<slug>/agent.yml`                                                                      |
| Template     | `<ever-works/agents-repo>/<template-slug>/agent.yml`                                                                 |

The schema is identical across all scopes. A template's `agent.yml` lacks the per-instance fields (`createdAt`, `lastRunAt`, etc.) — they get populated when the template is instantiated.

## 2. Full schema (Zod)

Lives at `packages/agent/src/agents/agent-manifest.schema.ts`:

```typescript
import { z } from 'zod';

const cronOrManual = z.union([
    z.literal('manual'),
    z.string().regex(/^[\s\S]{1,64}$/, 'cron expression too long').refine(
        (s) => parseCron(s).isValid(),
        { message: 'invalid cron expression' }
    ),
]);

const agentPermissionsSchema = z.object({
    canCreateAgents: z.boolean().default(false),
    canAssignTasks: z.boolean().default(false),
    canEditSkills: z.boolean().default(false),
    canEditAgentFiles: z.boolean().default(false),
    canSpend: z.boolean().default(false),
    canCommitToRepo: z.boolean().default(false),
    canOpenPullRequests: z.boolean().default(false),
    canCallExternalTools: z.boolean().default(false),
}).strict();

const agentBudgetSchema = z.object({
    intervalUnit: z.enum(['month', 'unlimited']),    // v1: only month + unlimited (see QUESTIONS N6)
    capCents: z.number().int().min(0),
    currency: z.string().length(3).default('usd'),
    allowOverage: z.boolean().default(false),
}).strict();

const agentAvatarSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('initials') }).strict(),
    z.object({ mode: z.literal('icon'), icon: z.string().min(1).max(64) }).strict(),
    z.object({ mode: z.literal('image'), uploadId: z.string().uuid() }).strict(),
]);

const agentSkillBindingSchema = z.object({
    slug: z.string(),
    injectIntoAgent: z.boolean().default(true),
    priority: z.number().int().min(0).default(100),
}).strict();

export const agentManifestSchema = z.object({
    // Identity
    apiVersion: z.literal('agent/v1'),
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/, 'slug must be kebab-case'),
    name: z.string().min(1).max(120),
    title: z.string().max(200).optional(),
    capabilities: z.string().max(5000).optional(),

    // Visual identity (H3 — all three modes)
    avatar: agentAvatarSchema.default({ mode: 'initials' }),

    // Scope (one of these is set; others null)
    scope: z.enum(['tenant', 'mission', 'idea', 'work']),
    missionId: z.string().uuid().optional().nullable(),
    ideaId: z.string().uuid().optional().nullable(),
    workId: z.string().uuid().optional().nullable(),

    // AI provider routing (null = use account default per ADR-006 cascade)
    aiProviderId: z.string().max(100).nullable().default(null),
    modelId: z.string().max(100).nullable().default(null),
    maxSkillContextTokens: z.number().int().min(0).max(20000).default(4000),

    // Heartbeat
    heartbeatCadence: cronOrManual.default('manual'),
    pauseAfterFailures: z.number().int().min(1).max(20).default(3),
    idleBehavior: z.enum(['propose', 'noop', 'observe']).default('propose'),

    // Permissions
    permissions: agentPermissionsSchema.default({}),

    // Budget
    budget: agentBudgetSchema.optional(),

    // Templates can pre-declare bundled skills
    skills: z.array(agentSkillBindingSchema).default([]),

    // Tenant-scoped agents can have explicit memberships
    targets: z.array(z.object({
        type: z.enum(['mission', 'idea', 'work', 'wildcard']),
        id: z.string().uuid().optional(),
    })).optional(),

    // Metadata for templates
    templateMeta: z.object({
        version: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
        author: z.string().optional(),
        tags: z.array(z.string()).default([]),
        description: z.string().max(500).optional(),
    }).optional(),
}).strict()
  .refine(
      (m) => scopeAndTargetIdConsistent(m),
      { message: 'scope must match the populated target id (missionId/ideaId/workId)' }
  );

export type AgentManifest = z.infer<typeof agentManifestSchema>;
```

## 3. Validation rules (cross-field)

Implemented in the `.refine()` clauses + service-layer checks:

| Rule                                                                                              | Where                                       |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `scope = 'tenant'` ⇒ all of `missionId / ideaId / workId` MUST be null.                          | `scopeAndTargetIdConsistent`                |
| `scope = 'mission'` ⇒ `missionId` MUST be set; others null.                                       | Same.                                       |
| `scope = 'idea'` ⇒ `ideaId` MUST be set; others null.                                             | Same.                                       |
| `scope = 'work'` ⇒ `workId` MUST be set; others null.                                             | Same.                                       |
| `targets` only valid when `scope = 'tenant'`.                                                     | Custom refine.                               |
| `avatar.mode = 'image'` requires tenant storage plugin enabled.                                   | Service-layer check at write time.           |
| `avatar.mode = 'icon'` ⇒ `icon` must be in the platform's curated icon set (validated at runtime). | Service-layer check.                         |
| `heartbeatCadence` cron string must validate via `cron-parser`.                                   | Schema-level via the `cronOrManual` union.   |
| `permissions.canOpenPullRequests` requires `permissions.canCommitToRepo`.                          | Custom refine.                               |
| `budget.intervalUnit` in v1 is `month | unlimited` only (per QUESTIONS N6).                       | Already in schema.                           |

## 4. Defaults and "use account default" semantics

Several fields use `null` as a sentinel for "use account default" — explicit in the schema:

- `aiProviderId: null` → resolve via the existing `AiFacadeService` cascade (per [agent-prompt-assembly.md](./agent-prompt-assembly.md)).
- `modelId: null` → use the resolved provider's `defaultModel` setting.
- `budget` omitted → no budget enforcement (no cap; ledger still records spend).

A template typically leaves these `null` so the instantiating tenant's account defaults apply. A specific user-authored agent may set them explicitly.

## 5. Example — CEO template (shipped in `ever-works/agents`)

```yaml
# ever-works/agents/ceo/agent.yml
apiVersion: agent/v1
slug: ceo
name: CEO
title: Chief Executive Officer
capabilities: |
    You're the CEO. Each Monday check the business, find the most important
    thing, delegate one task to the right Agent.

avatar:
    mode: icon
    icon: Briefcase

scope: tenant

aiProviderId: null
modelId: null

heartbeatCadence: "0 9 * * MON"
idleBehavior: propose
pauseAfterFailures: 3

permissions:
    canAssignTasks: true
    canCreateAgents: false
    canCommitToRepo: false
    canCallExternalTools: false

budget:
    intervalUnit: month
    capCents: 2000
    currency: usd
    allowOverage: false

skills:
    - slug: weekly-status
      injectIntoAgent: true
      priority: 100

templateMeta:
    version: "1.0.0"
    author: "Ever Works"
    tags: [executive, strategic, weekly]
    description: "Weekly executive check-in — reviews state, delegates one task to the right Agent."
```

## 6. Example — Mission-scoped researcher (user-authored)

```yaml
# <missionRepo>/.works/agents/catnip-researcher/agent.yml
apiVersion: agent/v1
slug: catnip-researcher
name: Catnip Researcher
title: Investigative researcher
capabilities: |
    Investigate catnip varietals, cultivation, supply chain. Report
    findings as a KB document; flag standout opportunities as Tasks.

avatar:
    mode: image
    uploadId: 8c7e2a1f-3b4d-4f5e-9a0b-1c2d3e4f5a6b

scope: mission
missionId: 5d4e3f2a-1b0c-9d8e-7f6a-5b4c3d2e1f0a

aiProviderId: anthropic
modelId: claude-sonnet-4-6
maxSkillContextTokens: 6000

heartbeatCadence: "0 6 * * *"
idleBehavior: propose

permissions:
    canCreateAgents: false
    canAssignTasks: true
    canCommitToRepo: true
    canCallExternalTools: true

budget:
    intervalUnit: month
    capCents: 5000

skills:
    - slug: market-research
      injectIntoAgent: true
      priority: 50
    - slug: kb-summarize
      injectIntoAgent: true
      priority: 80
```

## 7. Backwards compatibility & migration

- `apiVersion: agent/v1` enables future schema evolution. v2 would set `apiVersion: agent/v2`; parser branches per version.
- Adding new optional fields in v1 is non-breaking — defaults fill in.
- Removing/renaming fields requires `apiVersion` bump.
- The `agent.yml` files in `ever-works/agents` template repo are ref-pinned per [ADR-014](../decisions/014-no-hardcoded-catalogs.md) — bumping schema requires updating both the platform parser and template ref.

## 8. Validation lifecycle

| Event                              | Validator              | Failure mode                                                        |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| User saves via UI editor           | Zod schema             | Save rejected; UI highlights offending fields                       |
| Template read at create time       | Zod schema             | Template skipped; warning surfaced in admin logs                    |
| `gitFacade` pulls a Mission repo   | Zod schema             | Agent row marked `error`; visible in UI with "manifest invalid" banner |
| AI tool `editAgentFile('agent.yml')` | Zod schema + secret scan | Tool returns `validation_failed` error                              |

## 9. References

- [`agents/spec.md`](../features/agents/spec.md) — product behavior.
- [`agents/plan.md`](../features/agents/plan.md) — entity columns + DTOs.
- [`agent-prompt-assembly.md`](./agent-prompt-assembly.md) — uses these manifest fields to assemble the system message.
- [`agent-tools-catalog.md`](./agent-tools-catalog.md) — `editAgentFile` tool surface.
- ADR-011, ADR-014 — repo storage.
- Mission Templates precedent: `MissionTemplateManifestService` (Phase 8 PR JJ on develop) — `.works/mission.yml` Zod schema we mirror.
