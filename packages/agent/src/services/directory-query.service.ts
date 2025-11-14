import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DirectoryGenerationHistoryRepository } from '@src/database/repositories/directory-generation-history.repository';
import { DataGeneratorService } from '@src/data-generator/data-generator.service';
import { User } from '@src/entities/user.entity';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { normalizeGeneratorError } from './utils/error.utils';
import {
    DirectoryGenerationHistoryDto,
    DirectoryGenerationHistoryListDto,
} from '@src/dto/directory-generation-history.dto';
import { DirectoryGenerationHistory } from '@src/entities/directory-generation-history.entity';

@Injectable()
export class DirectoryQueryService {
    private readonly logger = new Logger(DirectoryQueryService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        private readonly ownershipService: DirectoryOwnershipService,
    ) {}

    async getDirectories(
        options: { limit?: number; offset?: number; search?: string } = {},
        user: User,
    ) {
        const { limit = 20, offset = 0, search } = options;

        let sanitizedSearch: string | undefined;
        if (search) {
            sanitizedSearch = search.trim().slice(0, 100) || undefined;
        }

        try {
            let directories = await this.directoryRepository.findAll({
                userId: user.id,
                limit,
                offset,
                search: sanitizedSearch,
            });

            directories = directories.map((dir) => {
                dir.owner = dir.getRepoOwner();
                return dir;
            });

            const total = await this.directoryRepository.countAll({
                userId: user.id,
                search: sanitizedSearch,
            });

            return {
                status: 'success',
                directories,
                total,
                limit,
                offset,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to get directories:', error);

            throw new BadRequestException({
                status: 'error',
                message: normalizeGeneratorError(error),
            });
        }
    }

    async getDirectory(id: string, user: User) {
        try {
            const directory = await this.ownershipService.ensure(id, user.id);
            directory.owner = directory.getRepoOwner();

            return {
                status: 'success',
                directory,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to get directory:', error);

            throw new BadRequestException({
                status: 'error',
                message: normalizeGeneratorError(error),
            });
        }
    }

    async directoryExists(slug: string, user: User) {
        return this.directoryRepository.existsByUserAndSlug(user.id, slug);
    }

    async directoryItems(directoryId: string, user: User) {
        const directory = await this.ownershipService.ensure(directoryId, user.id);

        try {
            const items = await this.dataGenerator.getItems(directory, user);
            return {
                status: 'success',
                items,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to get directory items:', error);

            const errMessage = normalizeGeneratorError(error);
            if (errMessage.includes('Repository not found')) {
                return {
                    status: 'success',
                    items: [],
                };
            }

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async directoryConfig(directoryId: string, user: User) {
        const directory = await this.ownershipService.ensure(directoryId, user.id);

        try {
            const config = await this.dataGenerator.config(directory, user);
            return {
                status: 'success',
                config,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            if (errMessage.includes('Repository not found')) {
                return {
                    status: 'success',
                    config: null,
                };
            }

            this.logger.error('Failed to get directory config:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async directoryCount(directoryId: string, user: User) {
        const directory = await this.ownershipService.ensure(directoryId, user.id);

        try {
            const count = await this.dataGenerator.count(directory, user);
            return {
                status: 'success',
                ...count,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            if (errMessage.includes('Repository not found')) {
                return {
                    status: 'success',
                    items: 0,
                    categories: 0,
                    tags: 0,
                };
            }

            this.logger.error('Failed to get directory count:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async directoryCategoriesTags(directoryId: string, user: User) {
        const directory = await this.ownershipService.ensure(directoryId, user.id);

        try {
            const { categories, tags } = await this.dataGenerator.getCategoriesTags(
                directory,
                user,
            );
            return {
                status: 'success',
                categories,
                tags,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);

            if (errMessage.includes('Repository not found')) {
                return {
                    status: 'success',
                    categories: [],
                    tags: [],
                };
            }

            this.logger.error('Failed to get directory categories and tags:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async directoryGenerationHistory(
        directoryId: string,
        user: User,
        options: { limit?: number; offset?: number } = {},
    ): Promise<DirectoryGenerationHistoryListDto> {
        const directory = await this.ownershipService.ensure(directoryId, user.id);

        const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
        const offset = Math.max(options.offset ?? 0, 0);

        const [history, total] = await Promise.all([
            this.generationHistoryRepository.findByDirectory(directory.id, limit, offset),
            this.generationHistoryRepository.countByDirectory(directory.id),
        ]);

        return {
            history: history.map((record) => this.toGenerationHistoryDto(record)),
            total,
            limit,
            offset,
        };
    }

    private toGenerationHistoryDto(
        record: DirectoryGenerationHistory,
    ): DirectoryGenerationHistoryDto {
        return {
            id: record.id,
            status: record.status,
            generationMethod: record.generationMethod ?? null,
            startedAt: record.startedAt ? record.startedAt.toISOString() : null,
            finishedAt: record.finishedAt ? record.finishedAt.toISOString() : null,
            durationInSeconds: record.durationInSeconds ?? null,
            newItemsCount: record.newItemsCount,
            updatedItemsCount: record.updatedItemsCount,
            totalItemsCount: record.totalItemsCount,
            metrics: record.metrics ?? null,
            errorMessage: record.errorMessage ?? null,
            parameters: record.parameters ?? null,
            createdAt: record.createdAt.toISOString(),
            updatedAt: record.updatedAt.toISOString(),
        };
    }
}
