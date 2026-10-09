import 'server-only';
import type {
    InstanceStatsReportView,
    InstanceStatsStatus,
    StatsSendResult,
    WorksStatsV1Report,
} from '@ever-works/contracts';
import { ApiResponseError, serverFetch, serverMutation } from './server-api';

/**
 * Anonymous usage statistics — the web's client for `/api/instance-stats/*`.
 *
 * `status` answers `{enabled}` to anyone signed in and the full status to the
 * platform admin; every other call is the platform admin's. When the API has
 * the module off (the default; on only with `EVER_STATS_ENABLED=true`) every route answers 404.
 */
const BASE = '/instance-stats';

export const instanceStatsAPI = {
    status: () => serverFetch<InstanceStatsStatus>(`${BASE}/status`, { cache: 'no-store' }),
    /**
     * Whether this installation has the statistics module at all: `false`
     * only when the API answers 404 (not switched on by `EVER_STATS_ENABLED`).
     * Any other failure answers `true`, so the page can say that the status
     * could not be read rather than vanish.
     */
    isAvailable: async (): Promise<boolean> => {
        try {
            await instanceStatsAPI.status();
            return true;
        } catch (error) {
            return !(error instanceof ApiResponseError && error.statusCode === 404);
        }
    },
    last: () =>
        serverFetch<{ report: InstanceStatsReportView | null }>(`${BASE}/last`, {
            cache: 'no-store',
        }),
    preview: () =>
        serverMutation<WorksStatsV1Report>({
            endpoint: `${BASE}/preview`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),
    sendNow: () =>
        serverMutation<{ results: StatsSendResult[] }>({
            endpoint: `${BASE}/send-now`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),
    setEnabled: (enabled: boolean) =>
        serverMutation<{ enabled: boolean }>({
            endpoint: `${BASE}/toggle`,
            data: { enabled },
            method: 'PUT',
            wrapInData: false,
        }),
    resetIdentity: () =>
        serverMutation<{ instanceId: string; resetCount: number }>({
            endpoint: `${BASE}/reset-identity`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),
};
