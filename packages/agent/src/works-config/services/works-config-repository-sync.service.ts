import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { GitFacadeService } from '@src/facades/git.facade';
import { DataRepository } from '@src/generators/data-generator/data-repository';
import type { User } from '@src/entities/user.entity';
import { WorksConfigSyncFailedEvent, type WorksConfigSyncReason } from '@src/events';
import { WorksConfigProjectionService } from './works-config-projection.service';
import { WorksConfigWriterService } from './works-config-writer.service';

export type WorksConfigRepositorySyncOptions = {
    directoryId: string;
    userId: string;
    reason: WorksConfigSyncReason;
};

@Injectable()
export class WorksConfigRepositorySyncService {
    private readonly logger = new Logger(WorksConfigRepositorySyncService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly gitFacade: GitFacadeService,
        private readonly projection: WorksConfigProjectionService,
        private readonly writer: WorksConfigWriterService,
        @Optional()
        private readonly eventEmitter?: EventEmitter2,
    ) {}

    async syncDirectory(options: WorksConfigRepositorySyncOptions): Promise<void> {
        const directory = await this.directoryRepository.findById(options.directoryId);
        if (!directory?.user) {
            this.logger.warn(
                `Skipping works.yml sync for ${options.directoryId}: directory or owner was not found`,
            );
            return;
        }

        const owner = directory.getRepoOwner('data');
        const repo = directory.getDataRepo();
        const committer = directory.resolveCommitter(directory.user as User);

        try {
            const dest = await this.gitFacade.cloneOrPull(
                { owner, repo, committer },
                { userId: options.userId, providerId: directory.gitProvider },
            );
            const dataRepository = await DataRepository.create(dest);

            await this.writer.writeToDataRepository({
                directory,
                dataRepository,
                request: await this.projection.buildWriteRequest(directory),
            });

            const changes = await this.gitFacade.getStatus(
                directory.gitProvider,
                dataRepository.dir,
            );
            if (changes.length === 0) {
                this.logger.debug(`works.yml already up to date for ${owner}/${repo}`);
                return;
            }

            await this.gitFacade.addAll(directory.gitProvider, dataRepository.dir);
            await this.gitFacade.commit(
                directory.gitProvider,
                dataRepository.dir,
                `sync works.yml after ${options.reason}`,
                committer,
            );
            await this.gitFacade.push(
                { dir: dest },
                { userId: options.userId, providerId: directory.gitProvider },
            );
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            this.logger.warn(
                `Failed to sync works.yml for ${owner}/${repo}: ${errorMessage}`,
            );
            this.eventEmitter?.emit(
                WorksConfigSyncFailedEvent.EVENT_NAME,
                new WorksConfigSyncFailedEvent(
                    directory.id,
                    options.userId,
                    options.reason,
                    `${owner}/${repo}`,
                    errorMessage,
                ),
            );
        }
    }
}
