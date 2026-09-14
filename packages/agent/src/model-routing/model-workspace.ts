import type { ModelPolicyScheduleSource } from '@ever-works/contracts';

/**
 * Model accounts (AW-16) — which workspace a Model Account or Model Policy
 * belongs to, and the keys its rows are stored under.
 *
 * An organization is one workspace for everyone in it. Outside an
 * organization (the personal scope, where `organizationId` is null) the
 * workspace is the person's own.
 */
export interface ModelWorkspaceScope {
    /** The acting person (API) or the owner of the Run / Agent / Work (call path). */
    userId: string;
    tenantId: string | null;
    organizationId: string | null;
}

/** `org:<organizationId>` or `user:<userId>`. Never null, so unique indexes hold. */
export function modelWorkspaceKey(scope: ModelWorkspaceScope): string {
    return scope.organizationId ? `org:${scope.organizationId}` : `user:${scope.userId}`;
}

/**
 * The person whose PERSONAL workspace a row belongs to, or null for an
 * organization workspace. Stored as `ownerUserId`: deleting that person
 * deletes their personal accounts and policies, while an organization's rows
 * survive any one member — including their creator — leaving.
 */
export function modelWorkspaceOwnerUserId(scope: ModelWorkspaceScope): string | null {
    return scope.organizationId ? null : scope.userId;
}

export const WORKSPACE_POLICY_SCOPE_KEY = 'workspace';

export function agentPolicyScopeKey(agentId: string): string {
    return `agent:${agentId}`;
}

export function schedulePolicyScopeKey(source: ModelPolicyScheduleSource, ownerId: string): string {
    return `schedule:${source}:${ownerId}`;
}
