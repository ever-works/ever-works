import { Injectable, Optional } from '@nestjs/common';
import { DirectoryRepository } from '@src/database';
import { Directory } from '@src/entities/directory.entity';
import { DirectoryOperations } from './directory-operations.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DirectoryGenerationCompletedEvent } from '@src/events';

@Injectable()
export class DatabaseDirectoryOperationsService implements DirectoryOperations {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        @Optional() private readonly eventEmitter?: EventEmitter2,
    ) {}

    async updateDirectory(id: string, updateData: Partial<Directory>): Promise<void> {
        await this.directoryRepository.update(id, updateData);
    }

    async updateGenerateStatus(id: string, status: Directory['generateStatus']): Promise<void> {
        await this.directoryRepository.updateGenerateStatus(id, status);
    }

    async updateLastPullRequest(id: string, payload: Directory['lastPullRequest']): Promise<void> {
        await this.directoryRepository.updateLastPullRequest(id, payload);
    }

    async recordGenerationStartTime(id: string, startedAt: Date): Promise<void> {
        await this.directoryRepository.recordGenerationStartTime(id, startedAt);
    }

    async recordGenerationFinishTime(id: string, finishedAt: Date): Promise<void> {
        await this.directoryRepository.recordGenerationFinishTime(id, finishedAt);
    }

    async emitGenerationCompleted(directory: Directory): Promise<void> {
        if (!this.eventEmitter) {
            return;
        }

        this.eventEmitter.emit(
            DirectoryGenerationCompletedEvent.EVENT_NAME,
            new DirectoryGenerationCompletedEvent(directory),
        );
    }
}
