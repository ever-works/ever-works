import { Injectable } from '@nestjs/common';
import { GenerateStatusType } from '@ever-works/agent/entities';
import { TriggerInternalApiClient } from './trigger-internal-api.client';

type DispatchResponse = {
    dispatched: number;
};

@Injectable()
export class RemoteDirectoryScheduleService {
    constructor(private readonly apiClient: TriggerInternalApiClient) {}

    async dispatchDueSchedules(): Promise<DispatchResponse> {
        return this.apiClient.dispatchSchedules();
    }

    async markRunCompleted(
        scheduleId: string,
        options: { historyId?: string; status: GenerateStatusType },
    ) {
        await this.apiClient.markScheduleCompleted(scheduleId, options);
    }

    async markRunFailed(scheduleId: string, reason?: string) {
        await this.apiClient.markScheduleFailed(scheduleId, reason);
    }
}
