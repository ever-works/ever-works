/**
 * The registry — **deliberately empty**.
 *
 * Nothing reconciles anything yet, and this file is where that stops being true. Each entry below
 * is a planned reconciler from `docs/specs/features/app-works/APW-10-apps-hosting-tier/`; add the
 * implementation and push it into {@link RECONCILERS} in the same commit as its spec.
 *
 * | Reconciler | Watches | Task | What it owns |
 * |---|---|---|---|
 * | `work.reconciler.ts` | `Work` | T6 | the phase machine, the tenant namespace, the workloads, heartbeat + leader election |
 * | `quarantine.sequencer.ts` | `AbuseSignal` | T7 | cut a misbehaving tenant off inside the drill's time budget |
 * | `selfcheck.reconciler.ts` | `SelfCheck` | T9 | run the zone's own isolation probes and publish the verdict |
 * | `removal.reconciler.ts` | `Work` | T39 | `desiredState: removed` without deleting tenant data |
 * | `dependency.reconciler.ts` | `Work` | T43 | per-Work Postgres / Redis / bucket, and their release |
 *
 * Keeping the list here rather than in prose means {@link validateRegistry} can check it: an entry
 * that names a kind the CRDs do not define never reaches a cluster.
 */
import type { Reconciler } from '../reconciler.port.js';

/**
 * Every control loop this build will start.
 *
 * While it is empty the bootstrap refuses to start — see `validateRegistry`'s
 * `NO_RECONCILERS_REGISTERED`. That refusal is the honest state of this component today, and it is
 * far better than a Pod that goes `Ready` and reconciles nothing.
 */
export const RECONCILERS: readonly Reconciler[] = [];
