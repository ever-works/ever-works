import { Injectable } from '@nestjs/common';
import { Directory } from '@src/entities/directory.entity';
import { DirectoryOperations } from '@src/directory';
import { TriggerInternalApiClient } from './trigger-internal-api.client';
import { DirectoryCommandAction, DirectoryCommandPayloads } from './directory-command.types';

@Injectable()
export class RemoteDirectoryOperationsService implements DirectoryOperations {
    constructor(private readonly apiClient: TriggerInternalApiClient) {}

    async updateDirectory(id: string, updateData: Partial<Directory>): Promise<void> {
        await this.apiClient.sendDirectoryCommand(id, {
            action: DirectoryCommandAction.UPDATE,
            payload: { data: updateData },
        });
    }

    async updateGenerateStatus(id: string, status: Directory['generateStatus']): Promise<void> {
        await this.apiClient.sendDirectoryCommand(id, {
            action: DirectoryCommandAction.UPDATE_GENERATE_STATUS,
            payload: { status },
        });
    }

    async updateLastPullRequest(id: string, payload: Directory['lastPullRequest']): Promise<void> {
        await this.apiClient.sendDirectoryCommand(id, {
            action: DirectoryCommandAction.UPDATE_LAST_PULL_REQUEST,
            payload: { lastPullRequest: payload },
        });
    }

    async recordGenerationStartTime(id: string, startedAt: Date): Promise<void> {
        await this.apiClient.sendDirectoryCommand(id, {
            action: DirectoryCommandAction.RECORD_GENERATION_START,
            payload: {
                startedAt: startedAt.toISOString(),
            } as DirectoryCommandPayloads[DirectoryCommandAction.RECORD_GENERATION_START],
        });
    }

    async recordGenerationFinishTime(id: string, finishedAt: Date): Promise<void> {
        await this.apiClient.sendDirectoryCommand(id, {
            action: DirectoryCommandAction.RECORD_GENERATION_FINISH,
            payload: {
                finishedAt: finishedAt.toISOString(),
            } as DirectoryCommandPayloads[DirectoryCommandAction.RECORD_GENERATION_FINISH],
        });
    }

    async emitGenerationCompleted(directory: Directory): Promise<void> {
        await this.apiClient.sendDirectoryCommand(directory.id, {
            action: DirectoryCommandAction.EMIT_GENERATION_COMPLETED,
            payload:
                {} as DirectoryCommandPayloads[DirectoryCommandAction.EMIT_GENERATION_COMPLETED],
        });
    }
}
