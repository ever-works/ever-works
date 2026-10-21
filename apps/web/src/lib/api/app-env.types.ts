/**
 * Shapes shared by the Deploy tab's Environment card (client) and its server-only client / actions
 * (lane aw-env-smtp, APW-07 T24). No `'use client'`, no `server-only`: both sides import it.
 *
 * Routes:
 *  - `GET /api/works/:id/app-env` → {@link AppEnvListResponse}
 *  - `PUT /api/works/:id/app-env` → {@link AppEnvPatchResponse} with `{ values: { NAME: string | null } }`.
 *    Refusals: `400 invalidBody | tooManyNames | undeclaredName`, `403 editAccessRequired`,
 *    `409 specUnavailable`, `503 secureStorageUnavailable | storeUnavailable`.
 *
 * Neither answer ever carries a secret value — only whether one is `set` (FR-5).
 */

import type {
    AppEnvListResponse,
    AppEnvPatchResponse,
    AppEnvPatchResultItem,
    AppEnvVariableView,
} from '@ever-works/contracts';

export type { AppEnvListResponse, AppEnvPatchResponse, AppEnvPatchResultItem, AppEnvVariableView };

/** The code an action answers when the route is not deployed on this API (`404`). */
export const APP_ENV_ROUTE_UNAVAILABLE = 'route_unavailable';

/** One action's answer. */
export interface AppEnvActionResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    code?: string;
    httpStatus?: number;
    /** `undeclaredName`'s names. */
    names?: string[];
}

/** The per-value refusal codes that carry copy without parameters (`dashboard.workDetail.appEnv.errors.*`). */
export const APP_ENV_PLAIN_ERROR_CODES = [
    'invalidName',
    'reservedName',
    'valueTooLarge',
    'controlCharacter',
    'patternMismatch',
    'generatedValueUseRotate',
    'neverRotateNotAcknowledged',
    'secureStorageUnavailable',
    'tooManyValues',
    'valuesTooLarge',
] as const;

/** The dependency kinds the card names (`environment.kinds.*`). */
export const APP_ENV_DEPENDENCY_KINDS = ['postgres', 'redis', 'objectStorage', 'smtp'] as const;

/** A dependency kind the card has copy for. */
export type AppEnvDependencyKindLeaf = (typeof APP_ENV_DEPENDENCY_KINDS)[number];

/** Is `kind` one the card names? (Narrows it to a typed message leaf.) */
export function isAppEnvDependencyKindLeaf(kind: unknown): kind is AppEnvDependencyKindLeaf {
    return (
        typeof kind === 'string' && (APP_ENV_DEPENDENCY_KINDS as readonly string[]).includes(kind)
    );
}

/** A per-value refusal code with copy that needs no parameters. */
export type AppEnvPlainErrorCode = (typeof APP_ENV_PLAIN_ERROR_CODES)[number];

/** Is `code` one of {@link APP_ENV_PLAIN_ERROR_CODES}? */
export function isAppEnvPlainErrorCode(code: unknown): code is AppEnvPlainErrorCode {
    return (
        typeof code === 'string' && (APP_ENV_PLAIN_ERROR_CODES as readonly string[]).includes(code)
    );
}
