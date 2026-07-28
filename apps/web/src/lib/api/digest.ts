import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Web client for the digest surface (`/api/digest` on the platform API
 * — see `apps/api/src/digest/digest.controller.ts`).
 *
 * Neither the user id nor the organization id is ever sent: the
 * personal digest is composed for the session's own user and the
 * organization digest for the session's active organization, both
 * resolved server-side. There is deliberately nothing here that lets a
 * caller name a subject.
 */

export type DigestCadence = 'daily' | 'weekly';
export type DigestScope = 'personal' | 'organization';

export interface DigestPersonalSettings {
    enabled: boolean;
    cadence: DigestCadence;
}

export interface DigestOrganizationSettings {
    organizationId: string;
    displayName: string;
    enabled: boolean;
    cadence: DigestCadence;
    narrative: boolean;
    lastRunAt: string | null;
}

export interface DigestSettingsResponse {
    personal: DigestPersonalSettings;
    /** `null` when the session has no active organization. */
    organization: DigestOrganizationSettings | null;
    /** False ⇒ the narrative will be skipped, with a note, in every digest. */
    aiConfigured: boolean;
}

export interface UpdateDigestSettingsPayload {
    scope: DigestScope;
    enabled?: boolean;
    cadence?: DigestCadence;
    /** Organization scope only. */
    narrative?: boolean;
}

// NOTE: no leading `/api` here — `serverFetch`/`serverMutation` prepend
// `API_URL`, which `lib/constants.ts` normalises to already end in
// `/api`. Matches every other helper in this folder.
const BASE = '/digest';

export const digestAPI = {
    getSettings: async () => {
        return serverFetch<DigestSettingsResponse>(`${BASE}/settings`);
    },

    updateSettings: async (payload: UpdateDigestSettingsPayload) => {
        return serverMutation<DigestSettingsResponse>({
            endpoint: `${BASE}/settings`,
            data: payload,
            method: 'PUT',
            wrapInData: false,
        });
    },
};

export const getDigestSettings = () => digestAPI.getSettings();
export const updateDigestSettings = (payload: UpdateDigestSettingsPayload) =>
    digestAPI.updateSettings(payload);
