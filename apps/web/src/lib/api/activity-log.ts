import 'server-only';
import { serverFetch } from './server-api';

export interface ActivityLogEntry {
    id: string;
    userId: string;
    directoryId?: string;
    actionType: string;
    action: string;
    status: string;
    summary: string;
    details?: Record<string, any>;
    metadata?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
    createdAt: string;
    updatedAt: string;
    directory?: {
        id: string;
        name: string;
    };
}

export interface ActivityLogResponse {
    activities: ActivityLogEntry[];
    total: number;
}

export interface RunningCountResponse {
    count: number;
}

export interface GetActivityLogParams {
    actionType?: string;
    directoryId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    limit?: number;
    offset?: number;
}

export const activityLogAPI = {
    getAll: async (params?: GetActivityLogParams): Promise<ActivityLogResponse> => {
        const searchParams = new URLSearchParams();
        if (params?.actionType) searchParams.set('actionType', params.actionType);
        if (params?.directoryId) searchParams.set('directoryId', params.directoryId);
        if (params?.status) searchParams.set('status', params.status);
        if (params?.dateFrom) searchParams.set('dateFrom', params.dateFrom);
        if (params?.dateTo) searchParams.set('dateTo', params.dateTo);
        if (params?.search) searchParams.set('search', params.search);
        if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
        if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
        const query = searchParams.toString();
        return serverFetch<ActivityLogResponse>(`/activity-log${query ? `?${query}` : ''}`);
    },

    getRunningCount: async (): Promise<RunningCountResponse> => {
        return serverFetch<RunningCountResponse>('/activity-log/running-count');
    },

    getById: async (id: string): Promise<{ activity: ActivityLogEntry }> => {
        return serverFetch<{ activity: ActivityLogEntry }>(`/activity-log/${id}`);
    },
};
