import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DirectoryMemberRepository } from '@src/database/repositories/directory-member.repository';
import { DirectoryGenerationHistoryRepository } from '@src/database/repositories/directory-generation-history.repository';
import { DataGeneratorService } from '@src/data-generator/data-generator.service';
import { User } from '@src/entities/user.entity';
import { Directory } from '@src/entities/directory.entity';
import { DirectoryMemberRole } from '@src/entities/types';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { normalizeGeneratorError } from './utils/error.utils';
import {
    DirectoryGenerationHistoryDto,
    DirectoryGenerationHistoryListDto,
} from '@src/dto/directory-generation-history.dto';
import { DirectoryGenerationHistory } from '@src/entities/directory-generation-history.entity';

// Extended directory response type with userRole for API responses
// Uses Omit to exclude class methods from Directory, then adds userRole
type DirectoryMethods =
    | 'getDataRepo'
    | 'getWebsiteRepo'
    | 'getMainRepo'
    | 'getRepoOwner'
    | 'isCreator'
    | 'getMember'
    | 'hasAccess'
    | 'getUserRole';

export type DirectoryWithRole = Omit<Directory, DirectoryMethods> & {
    userRole: DirectoryMemberRole;
};

@Injectable()
export class DirectoryQueryService {
    private readonly logger = new Logger(DirectoryQueryService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryMemberRepository: DirectoryMemberRepository,
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
            // Get directory IDs where user has membership (not as creator)
            const memberDirectoryIds =
                await this.directoryMemberRepository.getAccessibleDirectoryIds(user.id);

            // Find all directories user has access to (as creator or member)
            let directories = await this.directoryRepository.findAllAccessible({
                userId: user.id,
                memberDirectoryIds,
                limit,
                offset,
                search: sanitizedSearch,
            });

            // Separate directories into owned vs member-accessed for role computation
            const nonOwnedDirectoryIds = directories
                .filter((dir) => dir.userId !== user.id)
                .map((dir) => dir.id);

            // Batch fetch member roles for non-owned directories (single query)
            const memberRoles = await this.directoryMemberRepository.getMemberRolesForDirectories(
                user.id,
                nonOwnedDirectoryIds,
            );

            // Add userRole to each directory without additional queries
            const directoriesWithRoles: DirectoryWithRole[] = directories.map((dir) => {
                dir.owner = dir.getRepoOwner();

                // Creator is always OWNER, otherwise look up member role
                const userRole =
                    dir.userId === user.id
                        ? DirectoryMemberRole.OWNER
                        : memberRoles.get(dir.id) || DirectoryMemberRole.VIEWER;

                return {
                    ...dir,
                    userRole,
                } as DirectoryWithRole;
            });

            const total = await this.directoryRepository.countAllAccessible({
                userId: user.id,
                memberDirectoryIds,
                search: sanitizedSearch,
            });

            return {
                status: 'success',
                directories: directoriesWithRoles,
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
            const accessResult = await this.ownershipService.ensureAccess(id, user.id);
            const directory = accessResult.directory;
            directory.owner = directory.getRepoOwner();

            // Return directory with user's role
            const directoryWithRole: DirectoryWithRole = {
                ...directory,
                userRole: accessResult.role,
            };

            return {
                status: 'success',
                directory: directoryWithRole,
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
        // Any access level can view items
        const { directory } = await this.ownershipService.ensureCanView(directoryId, user.id);

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
        // Any access level can view config
        const { directory } = await this.ownershipService.ensureCanView(directoryId, user.id);

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

    async getWebsiteSettings(directoryId: string, user: User) {
        // Any access level can view settings
        const { directory } = await this.ownershipService.ensureCanView(directoryId, user.id);

        try {
            const config = await this.dataGenerator.config(directory, user);
            return {
                status: 'success',
                settings: config?.settings || {},
                custom_menu: config?.custom_menu || { header: [], footer: [] },
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            if (errMessage.includes('Repository not found')) {
                return {
                    status: 'success',
                    settings: {},
                    custom_menu: { header: [], footer: [] },
                };
            }

            this.logger.error('Failed to get website settings:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async updateWebsiteSettings(
        directoryId: string,
        user: User,
        dto: {
            categories_enabled?: boolean;
            companies_enabled?: boolean;
            tags_enabled?: boolean;
            surveys_enabled?: boolean;
            header?: {
                submit_enabled?: boolean;
                pricing_enabled?: boolean;
                layout_enabled?: boolean;
                language_enabled?: boolean;
                theme_enabled?: boolean;
                layout_default?: string;
                pagination_default?: string;
                theme_default?: string;
            };
            homepage?: {
                hero_enabled?: boolean;
                search_enabled?: boolean;
                default_view?: string;
                default_sort?: string;
            };
            footer?: {
                subscribe_enabled?: boolean;
                version_enabled?: boolean;
                theme_selector_enabled?: boolean;
            };
            custom_menu?: {
                header?: Array<{
                    label: string;
                    path: string;
                    target?: '_self' | '_blank';
                    icon?: string;
                }>;
                footer?: Array<{
                    label: string;
                    path: string;
                    target?: '_self' | '_blank';
                    icon?: string;
                }>;
            };
        },
    ) {
        // Require edit access to update settings
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);

        try {
            const { custom_menu, ...settings } = dto;
            await this.dataGenerator.updateWebsiteSettings(directory, user, settings, custom_menu);
            return {
                status: 'success',
                message: 'Website settings updated successfully',
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            this.logger.error('Failed to update website settings:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async directoryCount(directoryId: string, user: User) {
        // Any access level can view count
        const { directory } = await this.ownershipService.ensureCanView(directoryId, user.id);

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
        // Any access level can view categories and tags
        const { directory } = await this.ownershipService.ensureCanView(directoryId, user.id);

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
        // Any access level can view generation history
        const { directory } = await this.ownershipService.ensureCanView(directoryId, user.id);

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
            triggerRunId: record.triggerRunId,
        };
    }
}
