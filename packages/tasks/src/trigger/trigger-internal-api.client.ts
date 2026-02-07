import { Injectable } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import {
    Directory,
    GenerateStatusType,
    NotificationType,
    NotificationCategory,
} from '@ever-works/agent/entities';
import { DirectoryCommand, DirectoryCommandAction } from '@ever-works/agent/tasks';

type DirectoryContextResponse = {
    directory: Directory;
    user: any;
    gitToken?: string;
};

type DispatchSchedulesResponse = {
    dispatched: number;
};

export interface PluginSnapshotEntry {
    adminSettings: Record<string, unknown>;
    adminSecretSettings: Record<string, unknown>;
    userSettings: Record<string, unknown>;
    userSecretSettings: Record<string, unknown>;
    userEnabled: boolean | null;
    directorySettings: Record<string, unknown>;
    directorySecretSettings: Record<string, unknown>;
    directoryEnabled: boolean | null;
    directoryActiveCapability: string | null;
    directoryPriority: number;
}

export interface PluginContextSnapshotDto {
    plugins: Record<string, PluginSnapshotEntry>;
}

export interface CreateNotificationPayload {
    userId: string;
    type: NotificationType;
    category: NotificationCategory;
    title: string;
    message: string;
    actionUrl?: string;
    actionLabel?: string;
    metadata?: Record<string, any>;
    isPersistent?: boolean;
    deduplicationKey?: string;
}

@Injectable()
export class TriggerInternalApiClient {
    private readonly baseUrl: string;
    private readonly secret: string;

    constructor() {
        this.baseUrl = config.trigger.getInternalBaseUrl() || '';
        this.secret = config.trigger.getInternalSecret() || '';

        if (!this.baseUrl) {
            throw new Error('TRIGGER_INTERNAL_API_URL is not configured');
        }

        if (!this.secret) {
            throw new Error('TRIGGER_INTERNAL_SECRET is not configured');
        }
    }

    async fetchDirectoryContext(
        directoryId: string,
        userId: string,
    ): Promise<DirectoryContextResponse> {
        const searchParams = new URLSearchParams({ userId });

        return this.request<DirectoryContextResponse>({
            method: 'GET',
            path: `/directories/${directoryId}/context?${searchParams.toString()}`,
        });
    }

    async sendDirectoryCommand<A extends DirectoryCommandAction>(
        directoryId: string,
        command: DirectoryCommand<A>,
    ): Promise<void> {
        await this.request<void>({
            method: 'POST',
            path: `/directories/${directoryId}/commands`,
            body: command,
        });
    }

    async dispatchSchedules(): Promise<DispatchSchedulesResponse> {
        return this.request<DispatchSchedulesResponse>({
            method: 'POST',
            path: `/schedules/dispatch`,
        });
    }

    async markScheduleCompleted(
        scheduleId: string,
        payload: { historyId?: string; status: GenerateStatusType },
    ): Promise<void> {
        await this.request<void>({
            method: 'POST',
            path: `/schedules/${scheduleId}/complete`,
            body: payload,
        });
    }

    async markScheduleFailed(scheduleId: string, reason?: string): Promise<void> {
        await this.request<void>({
            method: 'POST',
            path: `/schedules/${scheduleId}/fail`,
            body: { reason },
        });
    }

    async setCacheEntry(key: string, value: any, ttl?: number): Promise<void> {
        await this.request<void>({
            method: 'POST',
            path: `/cache`,
            body: { key, value, ttl },
        });
    }

    async getCacheEntry<T>(key: string): Promise<T | undefined> {
        const response = await this.request<{ key: string; value: T | undefined }>({
            method: 'GET',
            path: `/cache?key=${encodeURIComponent(key)}`,
        });

        return response?.value;
    }

    async deleteCacheEntry<T>(key: string): Promise<boolean> {
        const response = await this.request<{ deleted: boolean }>({
            method: 'DELETE',
            path: `/cache?key=${encodeURIComponent(key)}`,
        });

        return response.deleted;
    }

    /**
     * Fetch plugin context snapshot for a directory generation run.
     * Returns all per-level settings for every registered plugin.
     */
    async fetchPluginContext(
        directoryId: string,
        userId: string,
    ): Promise<PluginContextSnapshotDto> {
        const searchParams = new URLSearchParams({ userId, directoryId });

        return this.request<PluginContextSnapshotDto>({
            method: 'GET',
            path: `/plugins/context?${searchParams.toString()}`,
        });
    }

    /**
     * Create a notification via the internal API
     * Use this to notify users of account-level issues from tasks
     */
    async createNotification(
        payload: CreateNotificationPayload,
    ): Promise<{ notificationId: string }> {
        return this.request<{ notificationId: string }>({
            method: 'POST',
            path: `/notifications`,
            body: payload,
        });
    }

    private async request<T>({
        method,
        path,
        body,
    }: {
        method: string;
        path: string;
        body?: unknown;
    }): Promise<T> {
        const url = this.composeUrl(path);

        const response = await fetch(url, {
            method,
            headers: {
                'content-type': 'application/json',
                'x-trigger-secret': this.secret,
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Trigger internal API request failed (${response.status}): ${text}`);
        }

        if (response.status === 204) {
            return undefined as T;
        }

        const text = await response.text();

        return text ? (JSON.parse(text) as T) : (undefined as T);
    }

    private composeUrl(path: string): string {
        const trimmedBase = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
        const trimmedPath = path.startsWith('/') ? path.slice(1) : path;

        return `${trimmedBase}/${trimmedPath}`;
    }
}
