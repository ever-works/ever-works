import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { GitFacadeService } from '@src/facades/git.facade';
import { DataRepository } from '@src/generators/data-generator/data-repository';
import type { User } from '@src/entities/user.entity';
import { WorksConfigSyncFailedEvent, type WorksConfigSyncReason } from '@src/events';
import { WorksConfigProjectionService } from './works-config-projection.service';
import { WorksConfigWriterService } from './works-config-writer.service';

export type WorksConfigRepositorySyncOptions = {
    workId: string;
    userId: string;
    reason: WorksConfigSyncReason;
};

@Injectable()
export class WorksConfigRepositorySyncService {
    private readonly logger = new Logger(WorksConfigRepositorySyncService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly gitFacade: GitFacadeService,
        private readonly projection: WorksConfigProjectionService,
        private readonly writer: WorksConfigWriterService,
        @Optional()
        private readonly eventEmitter?: EventEmitter2,
    ) {}

    async syncWork(options: WorksConfigRepositorySyncOptions): Promise<void> {
        const work = await this.workRepository.findById(options.workId);
        if (!work?.user) {
            this.logger.warn(
                `Skipping works.yml sync for ${options.workId}: work or owner was not found`,
            );
            return;
        }

        const owner = work.getRepoOwner('data');
        const repo = work.getDataRepo();
        const committer = work.resolveCommitter(work.user as User);

        try {
            const dest = await this.gitFacade.cloneOrPull(
                { owner, repo, committer },
                { userId: options.userId, providerId: work.gitProvider },
            );
            const dataRepository = await DataRepository.create(dest);

            await this.writer.writeToDataRepository({
                work,
                dataRepository,
                request: await this.projection.buildWriteRequest(work),
            });

            const changes = await this.gitFacade.getStatus(work.gitProvider, dataRepository.dir);
            if (changes.length === 0) {
                this.logger.debug(`works.yml already up to date for ${owner}/${repo}`);
                return;
            }

            await this.gitFacade.addAll(work.gitProvider, dataRepository.dir);
            await this.gitFacade.commit(
                work.gitProvider,
                dataRepository.dir,
                `sync works.yml after ${options.reason}`,
                committer,
            );
            await this.gitFacade.pull(dest, committer, {
                userId: options.userId,
                providerId: work.gitProvider,
            });
            await this.pushSyncedConfig(dest, options.userId, work.gitProvider);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            this.logger.warn(`Failed to sync works.yml for ${owner}/${repo}: ${errorMessage}`);
            this.eventEmitter?.emit(
                WorksConfigSyncFailedEvent.EVENT_NAME,
                new WorksConfigSyncFailedEvent(
                    work.id,
                    options.userId,
                    options.reason,
                    `${owner}/${repo}`,
                    errorMessage,
                ),
            );
        }
    }

    private async pushSyncedConfig(dir: string, userId: string, providerId: string): Promise<void> {
        try {
            await this.gitFacade.push({ dir }, { userId, providerId });
        } catch (error) {
            if (!this.isNonFastForwardPushError(error)) {
                throw error;
            }

            this.logger.warn(
                'works.yml sync push was rejected as non-fast-forward; force pushing',
            );
            await this.gitFacade.push({ dir, force: true }, { userId, providerId });
        }
    }

    private isNonFastForwardPushError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        return (
            message.includes('not a simple fast-forward') ||
            message.includes('non-fast-forward') ||
            message.includes('fetch first')
        );
    }
}
