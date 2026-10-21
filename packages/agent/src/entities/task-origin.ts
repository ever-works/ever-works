/**
 * Works-security (2026-10-18) — the server-written provenance of a Task
 * (`Task.origin`). Only platform code sets it, at create time; no DTO accepts
 * it. A leaf module (no runtime imports) so guards can read it without pulling
 * the entity graph in.
 *
 *  - `app-provisioning` — filed by `AppProvisioningService.start` (APW-04). The
 *    App change guard exempts exactly these Tasks from its guarded-spec-block
 *    rule, because provisioning legitimately writes `source` / `blueprint`.
 */
export const TASK_ORIGIN_APP_PROVISIONING = 'app-provisioning' as const;

export type TaskOrigin = typeof TASK_ORIGIN_APP_PROVISIONING;
