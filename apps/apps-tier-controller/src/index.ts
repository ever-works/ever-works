/**
 * `ever-works-apps-tier-controller` — the Ever Works Apps hosting zone controller (APW-10).
 *
 * T3 ships the Kubernetes contract: the five `hosting.ever.works/v1alpha1` CRDs, generated from
 * `src/crds/*.ts` into `deploy/crds/*.yaml`. Later tasks add the tenant template (T4), the
 * validator (T5), the reconcilers (T6/T7/T9/T33) and the probe entrypoint (T8); nothing here
 * reconciles anything yet.
 *
 * @packageDocumentation
 */
export * from './crds/index.js';
