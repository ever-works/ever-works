import { Injectable, Logger } from '@nestjs/common';
import { ActivityLogRepository } from '@src/database/repositories/activity-log.repository';
import type {
    CreateActivityLogDto,
    ActivityLogQueryOptions,
    ActivityStatus,
} from '../entities/activity-log.types';
import type { ActivityLog } from '../entities/activity-log.entity';

@Injectable()
export class ActivityLogService {
    private readonly logger = new Logger(ActivityLogService.name);

    constructor(private readonly repository: ActivityLogRepository) {}

    async log(entry: CreateActivityLogDto): Promise<ActivityLog> {
        const activity = await this.repository.create(entry);
        this.logger.debug(
            `Activity logged: [${entry.actionType}] ${entry.summary} (user: ${entry.userId})`,
        );
        return activity;
    }

    async updateStatus(
        id: string,
        status: ActivityStatus,
        details?: Record<string, any>,
    ): Promise<ActivityLog | null> {
        const updateData: Partial<ActivityLog> = { status };
        if (details) {
            updateData.details = details;
        }
        return this.repository.update(id, updateData);
    }

    async findAll(
        query: ActivityLogQueryOptions,
    ): Promise<{ activities: ActivityLog[]; total: number }> {
        return this.repository.findByUserId(query);
    }

    async countRunning(userId: string): Promise<number> {
        return this.repository.countByStatus(userId, 'in_progress' as ActivityStatus);
    }

    async findById(id: string): Promise<ActivityLog | null> {
        return this.repository.findById(id);
    }

    async exportCsv(query: ActivityLogQueryOptions): Promise<string> {
        const { activities } = await this.repository.findByUserId({
            ...query,
            limit: 10000,
            offset: 0,
        });

        const headers = ['Date', 'Action Type', 'Action', 'Status', 'Directory', 'Summary'].join(
            ',',
        );

        const rows = activities.map((a) => {
            const directoryName = a.directory?.name || '';
            const summary = a.summary.replace(/"/g, '""');
            return [
                a.createdAt.toISOString(),
                a.actionType,
                a.action,
                a.status,
                `"${directoryName}"`,
                `"${summary}"`,
            ].join(',');
        });

        return [headers, ...rows].join('\n');
    }
}
