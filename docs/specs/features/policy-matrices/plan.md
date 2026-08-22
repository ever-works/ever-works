# Implementation Plan: Governance Policy Matrices (Merge Policy + Tool Grants)

> Structure and implementation detail for [`./spec.md`](./spec.md).
> The spec states **what**; this document states **how**.

**Feature ID**: `policy-matrices`
**Status**: `Implemented`
**Last updated**: 2026-08-22

---

## 1. Architecture Summary

Both matrices are split into a **pure half** and an **I/O half**, and the pure
half is split again between the contracts package and the agent package. That
three-way split is the central design decision:

```
@ever-works/contracts        types + constants + shape guards + pattern matchers
  src/policy/                  (zero-dependency; every writer can import it)
        │
        ▼
@ever-works/agent            resolution + decision (pure, side-effect free)
  src/policy/*.ts              resolveMergePolicyChain / evaluateAgentMerge
        │                      resolveToolGrantChain / decideToolGrant
        ▼
@ever-works/agent            services + repositories (I/O: load the four rows)
  src/policy/*.service.ts      MergePolicyService / ToolGrantService
        │
        ▼
injection tokens             MERGE_POLICY_ENFORCER / TOOL_GRANT_ENFORCER
        │                    consumed via @Optional() @Inject(...)
        ▼
apps/api                     HTTP surface for operators
  src/merge-policy/            GET  /api/merge-policy/resolve
  src/tool-grants/             GET/PUT/DELETE /api/tool-grants
```

**Why the shape guards live in `contracts`, not `agent`.** Validating a
five-field JSON object should not drag the entity graph in. The writers are
plural — the Work/Agent update paths in the agent package, the organization
update path in the API, and any future importer — and they only ever touch the
wire shape. Putting `sanitizeMergePolicyOverride` / `sanitizeToolGrantOverride`
next to their types keeps `contracts` the one import site for anyone who is not
already inside the agent package. The agent package re-exports them so
`@ever-works/agent/policy` remains a single import site inside it.

**Why the pure half is separate from the services.** Resolution and decision are
side-effect free, so the precedence rules can be unit-tested without a database
and the same functions can run in the API, the worker, or a future edge caller.

**Why injection tokens rather than direct imports.** Both enforcers are
token + contract only, in leaf files with type-only imports — the same
circular-dependency dodge used by the other agent injection tokens (see
`docs/architecture/agent-injection-tokens.md`). `GitFacadeService` consumes
`MERGE_POLICY_ENFORCER`; `AgentRunService`, `AgentToolService` and
`SkillsService` consume `TOOL_GRANT_ENFORCER`. All use `@Optional() @Inject(...)`,
so leaving the token unbound restores pre-feature behaviour exactly (spec E7).

## 2. Tech Choices

| Concern                   | Choice                                                              | Why                                                                                                                |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Override storage (merge)  | `simple-json` columns on `tenants`/`organizations`/`works`/`agents` | Additive, no join, no new table for a five-field partial object.                                                   |
| Override storage (grants) | Dedicated `tool_grants` table                                       | Grants are user-scoped and independently listable/deletable; they need their own row identity.                     |
| Validation posture        | Drop-if-unrecognised, on the way **in** to resolution               | `simple-json` round-trips whatever was written and API/import payloads carry junk. Coercing could _loosen_ a rule. |
| Precedence enforcement    | Resolver sorts layers itself                                        | A caller that passed layers in the wrong order would invert the whole matrix; sorting removes that class of bug.   |
| Merge fold                | Field-by-field over `MERGE_POLICY_FIELDS`                           | Lets a Work change one knob and inherit the rest (spec FR-8).                                                      |
| Grant fold                | Intersection for `allow`, union for `deny`                          | Encodes narrow-only + additive-deny (spec FR-17, FR-18).                                                           |
| Pattern matching          | Hand-rolled `*` / `prefix*` / exact, case-insensitive               | A glob library would accept syntax the spec does not define; case-insensitivity is a stated security property.     |
| Credential ref matcher    | Factory returning a fresh `/g` RegExp                               | A shared `/g` instance carries `lastIndex` and silently skips matches on the second call (spec FR-25).             |
| Enforcer binding          | `@Optional() @Inject(TOKEN)`                                        | Fails **safe** (pre-feature behaviour), not closed, on a DI mistake.                                               |

## 3. Data Model

### Columns / entities

- `mergePolicy` — a nullable `simple-json` column carrying a `MergePolicyOverride`
  on each of `tenants`, `organizations`, `works`, `agents`.
- `tool_grants` — a user-scoped table holding one `ToolGrantOverride` per
  (scope, scope-id) pair.

### Migrations

Forward-only, per Constitution Principle V:

- `1784000000000-AddMergePolicyColumns`
- `1784780000000-CreateToolGrants`

### Contracts

`packages/contracts/src/policy/`:

| File                          | Contents                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge-policy.types.ts`       | `MergeMethod`, `MergePolicy`, `MergePolicyOverride`, `MergePolicyScope`/`Source`, chain + decision types, `MERGE_METHODS`, `MERGE_POLICY_SCOPE_PRECEDENCE`, `PLATFORM_DEFAULT_MERGE_POLICY`, `MERGE_POLICY_FIELDS`                                                                                                                          |
| `merge-policy.sanitize.ts`    | `sanitizeMergePolicyOverride`                                                                                                                                                                                                                                                                                                               |
| `tool-grant.types.ts`         | `ToolGrantScope`/`Source`, `ToolGrantOverride`, `ToolGrantMatrix`, chain + decision types, `TOOL_GRANT_SCOPE_PRECEDENCE`, `PLATFORM_DEFAULT_TOOL_GRANT`, `matchesToolPattern`, `matchesAnyToolPattern`, `toolPatternCovers`, `TOOL_NAME_PATTERN`, `TOOL_GRANT_PATTERN`, `credentialRefPattern`, `CREDENTIAL_KEY_PATTERN`, `isCredentialKey` |
| `tool-grant.sanitize.ts`      | `sanitizeToolGrantOverride`                                                                                                                                                                                                                                                                                                                 |
| `agent-capabilities.types.ts` | `AGENT_INIT_SCRIPT_MAX_BYTES` and the capability shapes                                                                                                                                                                                                                                                                                     |

## 4. API Surface

| Method + path                      | Purpose                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `GET /api/merge-policy/resolve`    | Effective merge policy + `source` + `chain` for a scope combination.  |
| `GET /api/tool-grants/resolve`     | Effective matrix + `source` + `chain`.                                |
| `GET /api/tool-grants/check`       | Decide a single tool name against the effective matrix.               |
| `GET /api/tool-grants`             | List stored grant rows for the caller.                                |
| `PUT /api/tool-grants`             | Upsert one grant row.                                                 |
| `DELETE /api/tool-grants/:id`      | Delete one grant row.                                                 |
| `GET /api/agents/:id/capabilities` | Agent-scoped capability projection that reflects the resolved matrix. |

All inherit the global `AuthSessionGuard`. Grant rows are user-scoped, so reads
and writes filter on the caller's `userId`.

## 5. Plugin Surface

None. This is core governance with no external provider to swap — Constitution
Principle I does not apply (see spec §9).

## 6. Web / CLI Surface

The HTTP surface exists and is consumable today. Dedicated settings screens for
editing the matrices are tracked separately (spec §6, Out of Scope).

## 7. Background Jobs

None. Resolution and decision are synchronous, pure and sub-millisecond, so
Constitution Principle IV does not apply.

## 8. Security & Permissions

- **Deny beats allow**, always, so a broad ancestor `allow` cannot defeat a
  targeted descendant `deny`.
- **No upward widening**: a child may only keep allow patterns an ancestor
  already covers, so delegating a scope to a less-trusted operator cannot
  escalate it.
- **Case-insensitive matching** — a grant that misses on case is a security bug,
  not a nicety.
- **Fail closed when a policy cannot be evaluated** (unknown target branch while
  branches are protected).
- **Fail safe when the feature itself is unwired** — an unbound enforcer restores
  pre-feature behaviour rather than taking the product down.
- **Credential references** (`{{cred.<key>}}`) resolve server-side immediately
  before the outbound call; the resolved value is never logged, persisted or
  echoed back to the model (Constitution Principle VII).

## 9. Observability

Every resolution returns a `chain` that attributes each contributed field or
pattern to a scope, plus the patterns that were **rejected** by the narrowing
rule. Refusals carry a stable machine-readable `code` alongside a human `reason`
that names the offending value, so logs and UI can group by code while still
telling the operator what to change.

## 10. Phased Rollout

1. Contracts: types, constants, shape guards, pattern matchers.
2. Agent package: pure resolution + decision functions.
3. Agent package: services + repositories (the I/O half).
4. Injection tokens + optional binding at the consumption sites.
5. API: operator endpoints.
6. Tests pinning every constant, branch and refusal code.

## 11. Risks & Mitigations

| Risk                                                                                                                       | Mitigation                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A caller passes layers in the wrong order and inverts the matrix.                                                          | The resolver sorts by the documented precedence itself; callers cannot invert it.                          |
| Junk in a `simple-json` column silently loosens a rule.                                                                    | Validate on the way in; drop unrecognised values rather than coercing them.                                |
| An empty list is mistaken for "unset" and silently inherits.                                                               | Empty-but-declared is explicitly distinguished from entirely-invalid; both paths are unit-tested.          |
| A DI mistake leaves an enforcer unbound and disables governance.                                                           | Documented, deliberate: unbound = pre-feature behaviour. The alternative (fail closed) would be an outage. |
| A shared `/g` regex skips matches on its second use.                                                                       | The credential matcher is a factory; every caller gets its own instance.                                   |
| A future tool name in a new case convention slips past a grant.                                                            | Matching is case-insensitive by construction.                                                              |
| A silent addition to a constant list changes behaviour unnoticed.                                                          | Unit tests pin every list's members, count and order.                                                      |
| `PLATFORM_DEFAULT_MERGE_POLICY`'s nested arrays are not frozen, so a stray `.push()` widens a safety control process-wide. | Latent only — the resolver clones before folding. Pinned by test; deep-freezing is tracked as spec OQ-5.   |

## 12. Constitution Reconciliation

See [`./spec.md` §9](./spec.md#9-constitution-gates). Principles I, II, IV and
VIII are non-applicable and explained there; III, V, VI, VII, IX and X are
satisfied.

## 13. References

- Behaviour spec: [`./spec.md`](./spec.md)
- Task breakdown: [`./tasks.md`](./tasks.md)
- Architecture: [`docs/architecture/agent-injection-tokens.md`](../../../architecture/agent-injection-tokens.md)
