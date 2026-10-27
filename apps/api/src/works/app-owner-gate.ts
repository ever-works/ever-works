import { HttpException, HttpStatus } from '@nestjs/common';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { requireHumanSession } from '../auth/machine-principal';

/**
 * Works-security lane (2026-10-18) — the refusal every owner-only App Works action gives.
 *
 * The switches and the reasons live in `packages/agent/src/app-runtime/app-owner-gates.ts`; this
 * is the HTTP half the controllers share:
 *
 *   1. **the owner** — `WorkOwnershipService.ensureIsOwner`. A member who is not the owner (an
 *      editor or a manager, or their personal API key) gets `403 { code: 'ownerRequired' }` with
 *      a sentence naming the action, which the web shows as-is;
 *   2. **a person** — `requireHumanSession`: the owner's own `ew_live_` key, a fleet-run token or
 *      an integration key cannot take these decisions, because a model holding one of them can be
 *      steered by what it reads (`machine-principal.ts`).
 *
 * The caller has already resolved `edit` (or `view`) access, so a Work the caller cannot see
 * has already answered `404` before this runs.
 */
export const APP_OWNER_REQUIRED_CODE = 'ownerRequired';

/**
 * The three switches, read per call. They mirror `appTargetChangeRequiresOwner` /
 * `appDataDeleteOwnerOnly` / `appLicenseAttestSessionOnly` in
 * `packages/agent/src/app-runtime/app-owner-gates.ts` (same names, same rule: ON unless exactly
 * `false`) and are kept here so the controllers do not load the App runtime barrel for a flag.
 */
type EnvLike = Record<string, string | undefined>;

function defaultOn(name: string, env: EnvLike | undefined): boolean {
    return (
        String((env ?? process.env)[name] ?? '')
            .trim()
            .toLowerCase() !== 'false'
    );
}

export function appTargetChangeRequiresOwner(env?: EnvLike): boolean {
    return defaultOn('APP_TARGET_CHANGE_REQUIRES_OWNER', env);
}

export function appDataDeleteOwnerOnly(env?: EnvLike): boolean {
    return defaultOn('APP_DATA_DELETE_OWNER_ONLY', env);
}

export function appLicenseAttestSessionOnly(env?: EnvLike): boolean {
    return defaultOn('APP_LICENSE_ATTEST_SESSION_ONLY', env);
}

export async function requireAppWorkOwnerSession(
    ownership: Pick<WorkOwnershipService, 'ensureIsOwner'>,
    workId: string,
    auth: AuthenticatedUser,
    action: string,
): Promise<void> {
    let isOwner = false;
    try {
        await ownership.ensureIsOwner(workId, auth.userId);
        isOwner = true;
    } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const status = error.getStatus();
        if (status !== HttpStatus.FORBIDDEN && status !== HttpStatus.NOT_FOUND) throw error;
    }
    if (!isOwner) {
        throw new HttpException(
            {
                status: 'error',
                code: APP_OWNER_REQUIRED_CODE,
                message: `Only the Work owner can ${action}.`,
            },
            HttpStatus.FORBIDDEN,
        );
    }
    requireHumanSession(auth, action);
}

/**
 * Whether a resolved access is the owner's (`WorkMemberRole.OWNER`, the creator's implicit role).
 * Compared by value so this file needs no entities barrel (several controller specs stub it).
 */
export function isOwnerAccess(access: { role?: unknown } | null | undefined): boolean {
    return access?.role === 'owner';
}

/** True when `value` is something a body "carries" — not absent, not null, not blank text. */
export function carriesValue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
}
