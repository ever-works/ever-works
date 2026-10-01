import type { PluginOperationPayload } from '@ever-works/agent/tasks';

/**
 * The `run-plugin-operation` run payload, built from what the plugin execution
 * router dispatched: `{ pluginId, operation, args }`, plus the tenant fields a
 * tenant call carries (T26 / EW-742 P3 FR-5: `tenantId` and the stamper's
 * `providerId` / `credentialVersion`, which may be `null`).
 *
 * `args` is always set, as before. A tenant field the payload does not have is
 * left out rather than sent as `undefined`, so a platform call's payload stays
 * exactly `{ pluginId, operation, args }`.
 * Shared by the platform dispatcher (`TriggerService.dispatchPluginOperation`)
 * and the BYO one (`dispatchersFromTenantClient`), so the two cannot differ.
 * Dependency-free on purpose: the tenant-client factory imports it without
 * pulling the worker's task graph in.
 */
export function pluginOperationRunPayload(payload: PluginOperationPayload): PluginOperationPayload {
    const run: {
        pluginId: string;
        operation: string;
        args?: Record<string, unknown>;
        tenantId?: string;
        providerId?: string | null;
        credentialVersion?: number | null;
    } = { pluginId: payload.pluginId, operation: payload.operation, args: payload.args };
    if (payload.tenantId !== undefined) run.tenantId = payload.tenantId;
    if (payload.providerId !== undefined) run.providerId = payload.providerId;
    if (payload.credentialVersion !== undefined) run.credentialVersion = payload.credentialVersion;
    return run;
}
