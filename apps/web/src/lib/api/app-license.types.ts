/**
 * Shapes shared by the licence attestation dialog (client) and its server-only
 * client / actions. No `'use client'`, no `server-only`: both sides import it.
 *
 * Routes:
 *  - `GET  /api/works/:id/app-license`        → {@link WorkAppLicenseView} (lane aw-web-2)
 *  - `POST /api/works/:id/app-license/attest` → `{ attestation }` (lane aw-catalog, #2683)
 *    with the classification the owner reviewed, `{ spdx, class }`; the API records
 *    `textId` / `textSha256` / `commitSha` itself. Refusals: `403 ownerOnly`,
 *    `409 licenseChanged`, `422 attestationNotRequired`, `503 licenseUnavailable`.
 */

import type { LicenseAttestation, LicenseClass } from '@ever-works/contracts';

export interface WorkAppLicenseView {
    workId: string;
    spdx: string | null;
    class: LicenseClass | null;
    source: string | null;
    mixed: boolean;
    scanIncomplete: boolean;
    obligations: readonly string[];
    commitSha: string | null;
    evaluatedAt: string | null;
    attestationRequired: boolean;
    attestation: LicenseAttestation | null;
    attestationText: { textId: string; text: string } | null;
    isOwner: boolean;
}

/** The code an action answers when the route is not deployed on this API (`404`). */
export const APP_LICENSE_ROUTE_UNAVAILABLE = 'route_unavailable';

/** The refusals the dialog has copy for. */
export const APP_LICENSE_ATTEST_REFUSALS = [
    'ownerOnly',
    'licenseChanged',
    'attestationNotRequired',
    'licenseUnavailable',
    APP_LICENSE_ROUTE_UNAVAILABLE,
] as const;

export type AppLicenseAttestRefusal = (typeof APP_LICENSE_ATTEST_REFUSALS)[number];

export interface AppLicenseActionResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    code?: string;
    httpStatus?: number;
}

/** Map an attest answer's status / code onto the dialog's refusal copy. */
export function attestRefusalOf(result: {
    code?: string;
    httpStatus?: number;
}): AppLicenseAttestRefusal | null {
    if (result.code && (APP_LICENSE_ATTEST_REFUSALS as readonly string[]).includes(result.code)) {
        return result.code as AppLicenseAttestRefusal;
    }
    if (result.httpStatus === 403) return 'ownerOnly';
    if (result.httpStatus === 409) return 'licenseChanged';
    if (result.httpStatus === 422) return 'attestationNotRequired';
    if (result.httpStatus === 503) return 'licenseUnavailable';
    if (result.httpStatus === 404) return APP_LICENSE_ROUTE_UNAVAILABLE;
    return null;
}
