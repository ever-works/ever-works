import 'server-only';
import type { LicenseAttestation } from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';
import type { WorkAppLicenseView } from './app-license.types';

/**
 * Server-only client for an App Work's licence (APW-03 T44 / APW-06 T37, R-3).
 * See `./app-license.types` for the routes and refusals. No leading `/api`:
 * `serverFetch` prepends `API_URL`, which already ends in `/api`.
 */
export const appLicenseAPI = {
    /** `GET /api/works/:id/app-license` — classification, need, stored record, the text to confirm. */
    get: async (workId: string): Promise<WorkAppLicenseView> => {
        return serverFetch<WorkAppLicenseView>(`/works/${encodeURIComponent(workId)}/app-license`);
    },

    /**
     * `POST /api/works/:id/app-license/attest` — the owner attests the
     * classification they reviewed; a moved classification answers `409`.
     */
    attest: async (
        workId: string,
        reviewed: { spdx: string | null; class: string | null },
    ): Promise<{ attestation: LicenseAttestation }> => {
        return serverMutation<{ attestation: LicenseAttestation }>({
            endpoint: `/works/${encodeURIComponent(workId)}/app-license/attest`,
            data: reviewed,
            method: 'POST',
            wrapInData: false,
        });
    },
};
