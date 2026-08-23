# Kubernetes Generated-Site Memory Safety Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` for each behavior change and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Make future generated-site Deployments advertise realistic memory, roll a single replica without a temporary duplicate, probe a lightweight health endpoint, and spread replicas across nodes.

**Scope:** Renderer and Kubernetes plugin settings only. Existing Work rows, generated repositories, live Deployments, routes, clusters, and node sizing are explicitly out of scope for this code change.

**Design:** The renderer defaults memory requests to a `512Mi` admission floor, the smallest request above the measured roughly 468–499 MiB low-water working sets. This floor is not a sufficiency claim for sites measured in the 0.4–0.8 GiB range; those need higher measured per-Work requests. Platform-managed sources normalize legacy explicit requests below `512Mi` during deploy only after validating the effective request/limit pair; custom clusters retain their values and the full Kubernetes quantity syntax. A settings hook rejects malformed managed quantities, request-over-limit, and new managed request/limit values below the floor. Single-replica Deployments use a surge-free `0/1` rollout, explicitly accepting a brief outage while the replacement becomes Ready; startup keeps `/` to warm the catalogue, readiness/liveness use `/api/health`, and a soft hostname topology spread preference applies to the existing pod selector.

## Task 1: Lock renderer behavior with failing tests

**Files:**

- Modify: `packages/plugins/k8s/src/__tests__/manifest.renderer.spec.ts`

1. Add tests for the `512Mi` default and explicit override.
2. Add tests for single-replica `maxSurge: 0` / `maxUnavailable: 1`, its intentional brief-outage tradeoff, and multi-replica `1/0`.
3. Add tests that startup keeps `/` for catalogue warm-up while readiness and liveness use `/api/health`.
4. Add a test for a soft hostname topology spread preference using the Deployment selector, avoiding tainted-control-plane hard-constraint deadlocks.
5. Run `pnpm test -- src/__tests__/manifest.renderer.spec.ts` and confirm the new assertions fail for the expected missing behavior.

## Task 2: Implement renderer safety defaults

**Files:**

- Modify: `packages/plugins/k8s/src/manifest.renderer.ts`

1. Render `512Mi` when no memory request is supplied.
2. Render a surge-free strategy for one replica while retaining ordinary rolling availability for multiple replicas.
3. Preserve the startup probe on `/` and point readiness/liveness at `/api/health`.
4. Add a hostname topology spread preference with `maxSkew: 1`, `ScheduleAnyway`, and the existing selector.
5. Re-run the renderer test and confirm it passes.

## Task 3: Lock managed-cluster settings behavior with failing tests

**Files:**

- Modify: `packages/plugins/k8s/src/__tests__/k8s.plugin.spec.ts`

1. Assert schema defaults without restricting Kubernetes' DecimalSI, BinarySI, or exponent syntax.
2. Assert validation accepts `512Mi`, `0.5Gi`, and exponent forms on managed sources and preserves valid custom-cluster quantities.
3. Assert validation rejects malformed managed quantities, request greater than limit, and managed request/limit values below `512Mi`.
4. Assert deploy normalizes a legacy managed `256Mi` override to `512Mi`, fails before any API write when the effective limit is too low, and preserves a custom-cluster `256Mi` override.
5. Run `pnpm test -- src/__tests__/k8s.plugin.spec.ts` and confirm the new assertions fail for the expected missing behavior.

## Task 4: Implement settings validation and legacy normalization

**Files:**

- Modify: `packages/plugins/k8s/src/k8s.plugin.ts`

1. Add exact Kubernetes DecimalSI, BinarySI, and DecimalExponent quantity parsing for managed-floor comparisons.
2. Add schema defaults without a syntax-narrowing pattern.
3. Add `validateSettings()` for managed quantity syntax, request/limit ordering, and managed-source minimum request/limit values while leaving custom-cluster validation to its API server.
4. Normalize legacy sub-minimum managed requests at deploy render time without changing stored Work settings, but fail safely before any API write if the effective limit cannot cover the request.
5. Re-run the focused tests and confirm they pass.

## Task 5: Verify the complete plugin change

1. Run `pnpm test -- src/__tests__/manifest.renderer.spec.ts src/__tests__/k8s.plugin.spec.ts`.
2. Run the package typecheck/build commands exposed by `packages/plugins/k8s/package.json`.
3. Run `git diff --check` and inspect the rendered manifest diff for one- and two-replica inputs.
4. Record rollback as reverting the renderer/plugin commit; no live resource changes are part of this code commit.
