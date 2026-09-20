/**
 * `@ever-works/apps-tier-crds` — the Ever Works Apps hosting tier's Kubernetes API contract (APW-10).
 *
 * This package holds the five `hosting.ever.works/v1alpha1` CRD schemas (`Work`, `AppBuild`,
 * `UsageReport`, `SelfCheck`, `AbuseSignal`) as code, plus the generator that renders them to
 * `deploy/crds/*.yaml`. It is a **library, deliberately**: both ends of the hosting tier need the
 * same schema and neither may fork it.
 *
 * - The **platform** side (`apps/api` through the `apps-tier` plugin capability,
 *   `IAppsTierProvider`) *writes* `Work` objects and *reads* their `status`.
 * - The **controller** side (`apps/apps-tier-controller`) runs inside the hosting cluster and
 *   reconciles them.
 *
 * Nothing in this package talks to a cluster, reads a kubeconfig, or reconciles anything — it is
 * pure schema. The reconcilers, the tenant template, the validator and the probe entrypoint belong
 * to `apps/apps-tier-controller` (APW-10 T4–T9, T23, T28, T29, T33); see that app's `README.md`.
 *
 * Layout note (owner ruling, 2026-09-20): this content originally shipped as
 * `apps/apps-tier-controller`. It was moved here because `apps/*` in this monorepo means "a thing
 * that starts a process" — every other entry has a `start` script or a `bin` — and this has
 * neither. `apps/apps-tier-controller` now holds the process.
 *
 * @packageDocumentation
 */
export * from './crds/index.js';
