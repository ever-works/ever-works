import type { TaskAuthorType } from '@ever-works/agent/tasks-domain';
import type { AuthenticatedUser } from '../types/auth.types';

/**
 * EW-P1-2 — who a write is attributed to (plan doc 02 §2 "Writes"):
 *
 * - a person (session, personal key, or an integration acting AS a validated
 *   user through `X-Act-As-User`) → `{ type: 'user', id: <userId> }`;
 * - an integration key writing WITHOUT act-as → `{ type: 'integration',
 *   id: <keyId> }`. The row's OWNER is still the key's owner (`userId`), so
 *   every ownership rule keeps working; only the creator/author says
 *   "integration".
 */
export function writeAttribution(user: AuthenticatedUser): { type: TaskAuthorType; id: string } {
    if (user.authMethod === 'integration' && user.integration && !user.integration.actAsUserId) {
        return { type: 'integration', id: user.integration.keyId };
    }
    return { type: 'user', id: user.userId };
}

/** True when the request was made with an integration key (`ew_int_…`). */
export function isIntegrationPrincipal(user: AuthenticatedUser | undefined | null): boolean {
    return user?.authMethod === 'integration' && !!user.integration;
}
