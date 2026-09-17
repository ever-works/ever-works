import { isFleetModelPluginId } from '@ever-works/contracts';
import type { SettingSource } from '@ever-works/plugin';

/**
 * The facts that decide who paid the provider for one usage row (or one
 * plugin's rows inside a run). Every field except `pluginId` is optional: a
 * fact the caller could not establish is simply left out, and a missing fact
 * never makes usage owner-paid.
 */
export interface OwnerPaidUsageFacts {
    /** The plugin that recorded the usage. */
    pluginId: string;
    /**
     * Where the plugin's `apiKey` resolved from (`ResolvedSetting.source`).
     * `user` / `work` mean the owner supplied the key; `admin` / `env` /
     * `default` are platform-supplied. Omit when provenance was not resolved.
     */
    apiKeySource?: SettingSource | null;
    /** `metadata.modelAccountId` on the usage row: the Model Account whose credentials served the call. */
    modelAccountId?: string | null;
    /**
     * That Model Account as stored, or null when no such account was found.
     * Only its workspace and provider are read.
     */
    modelAccount?: { workspaceKey: string; providerPluginId: string } | null;
    /**
     * The workspace the usage is charged to (`modelWorkspaceKey` of the run's
     * owner scope): `org:<organizationId>` or `user:<userId>`.
     */
    workspaceKey?: string | null;
}

/**
 * Is this usage owner-paid, i.e. the owner's own provider credentials served
 * it, so it consumes no platform credits?
 *
 * The one place this rule lives. Run-cost settlement uses it to exempt spend
 * from the credit debit; anything else that needs to label usage as the
 * owner's own (rather than platform-paid) should call it instead of
 * re-deriving the rule.
 *
 * Owner-paid when ANY of:
 *  - the row is a fleet node's model spend (`fleet-node:*`): billed to the CLI
 *    seat on the owner's own machine;
 *  - the plugin's `apiKey` resolved from the `user` or `work` settings level;
 *  - a Model Account served the call AND that account exists, belongs to the
 *    same workspace the usage is charged to, and holds credentials for the
 *    same provider plugin. An id pointing at another workspace's account (or
 *    at nothing) is not honoured.
 *
 * Never owner-paid on doubt: unresolved provenance bills at the platform rate.
 */
export function isOwnerPaidUsage(facts: OwnerPaidUsageFacts): boolean {
    if (isFleetModelPluginId(facts.pluginId)) {
        return true;
    }
    if (facts.apiKeySource === 'user' || facts.apiKeySource === 'work') {
        return true;
    }
    if (facts.modelAccountId && facts.modelAccount && facts.workspaceKey) {
        return (
            facts.modelAccount.workspaceKey === facts.workspaceKey &&
            facts.modelAccount.providerPluginId === facts.pluginId
        );
    }
    return false;
}
