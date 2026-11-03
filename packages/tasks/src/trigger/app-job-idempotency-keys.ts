import type { AppBlueprintApplyJobPayload } from '@ever-works/agent/app-works';

/**
 * The `idempotencyKey`s of the App jobs that carry one, shared by the platform
 * dispatchers (`TriggerService.dispatchAppUpstreamSync` /
 * `dispatchAppBlueprintApply`) and their BYO mirrors
 * (`dispatchersFromTenantClient`), so a tenant's run collapses exactly as a
 * platform one does. Dependency-free on purpose, like
 * `plugin-operation-run-payload.ts`: the tenant-client factory imports it
 * without pulling the worker's task graph in.
 */

/**
 * Plan §6.1:662 — `app-upstream-sync:<workId>:<trigger>:<minute bucket>`. The bucket is
 * the UTC minute (`YYYYMMDDHHmm`), so the key is stable for one minute and never longer.
 */
export function appUpstreamSyncIdempotencyKey(
    workId: string,
    trigger: string,
    now: Date = new Date(),
): string {
    const bucket = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return `app-upstream-sync:${workId}:${trigger}:${bucket}`;
}

/**
 * Per Work, mode, version and request time, so a retried enqueue of the same
 * request collapses while a later request still runs.
 */
export function appBlueprintApplyIdempotencyKey(payload: AppBlueprintApplyJobPayload): string {
    return `app-blueprint-apply:${payload.workId}:${payload.mode}:${payload.version}:${
        payload.requestedAt ?? ''
    }`;
}
