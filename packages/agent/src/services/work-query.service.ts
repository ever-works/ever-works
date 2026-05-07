import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { WorkMemberRepository } from '@src/database/repositories/work-member.repository';
import { WorkGenerationHistoryRepository } from '@src/database/repositories/work-generation-history.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { User } from '@src/entities/user.entity';
import { Work } from '@src/entities/work.entity';
import { WorkMemberRole, GenerateStatusType } from '@src/entities/types';
import { WorkOwnershipService } from './work-ownership.service';
import { normalizeGeneratorError, rethrowAsNormalized } from './utils/error.utils';
import {
    WorkGenerationHistoryDto,
    WorkGenerationHistoryListDto,
} from '@src/dto/work-generation-history.dto';
import { WorkGenerationHistory } from '@src/entities/work-generation-history.entity';
import { WorkHistoryActivityType } from '@ever-works/contracts/api';
import { WorkWebsiteRepositoryStateService } from './work-website-repository-state.service';

// Extended work response type with userRole for API responses
// Uses Omit to exclude class methods from Work, then adds userRole
type WorkMethods =
    | 'getDataRepo'
    | 'getWebsiteRepo'
    | 'getMainRepo'
    | 'getRepoOwner'
    | 'isCreator'
    | 'getMember'
    | 'hasAccess'
    | 'getUserRole'
    | 'resolveCommitter';

export type WorkWithRole = Omit<Work, WorkMethods> & {
    userRole: WorkMemberRole;
    websiteRepositoryInitialized?: boolean;
};

@Injectable()
export class WorkQueryService {
    private readonly logger = new Logger(WorkQueryService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
        private readonly dataGenerator: DataGeneratorService,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
        private readonly ownershipService: WorkOwnershipService,
        private readonly websiteRepositoryState: WorkWebsiteRepositoryStateService,
    ) {}

    async getWorks(options: { limit?: number; offset?: number; search?: string } = {}, user: User) {
        const { limit = 20, offset = 0, search } = options;

        let sanitizedSearch: string | undefined;
        if (search) {
            sanitizedSearch = search.trim().slice(0, 100) || undefined;
        }

        try {
            // Get work IDs where user has membership (not as creator)
            const memberWorkIds = await this.workMemberRepository.getAccessibleWorkIds(user.id);

            // Find all works user has access to (as creator or member)
            let works = await this.workRepository.findAllAccessible({
                userId: user.id,
                memberWorkIds,
                limit,
                offset,
                search: sanitizedSearch,
            });

            const workIdsNeedingRecoveredCounts = works
                .filter((dir) => this.shouldRecoverItemsCount(dir))
                .map((dir) => dir.id);

            const recoveredItemCounts =
                await this.generationHistoryRepository.findLatestPositiveItemCounts(
                    workIdsNeedingRecoveredCounts,
                );

            // Separate works into owned vs member-accessed for role computation
            const nonOwnedWorkIds = works
                .filter((dir) => dir.userId !== user.id)
                .map((dir) => dir.id);

            // Batch fetch member roles for non-owned works (single query)
            const memberRoles = await this.workMemberRepository.getMemberRolesForWorks(
                user.id,
                nonOwnedWorkIds,
            );

            // Add userRole to each work without additional queries
            const worksWithRoles: WorkWithRole[] = works.map((dir) => {
                dir.owner = dir.getRepoOwner();

                const recoveredItemsCount = recoveredItemCounts.get(dir.id);
                const itemsCount =
                    (dir.itemsCount ?? 0) > 0
                        ? dir.itemsCount
                        : (recoveredItemsCount ?? dir.itemsCount);

                // Creator is always OWNER, otherwise look up member role
                const userRole =
                    dir.userId === user.id
                        ? WorkMemberRole.OWNER
                        : memberRoles.get(dir.id) || WorkMemberRole.VIEWER;

                return {
                    ...dir,
                    itemsCount,
                    userRole,
                } as WorkWithRole;
            });

            const total = await this.workRepository.countAllAccessible({
                userId: user.id,
                memberWorkIds,
                search: sanitizedSearch,
            });

            // Diagnostic: explicit log when listing returns empty so we can
            // cross-check the user's id against the DB rows when needed.
            if (worksWithRoles.length === 0) {
                this.logger.log(
                    `getWorks: 0 works for user ${user.id} (memberWorkIds=${memberWorkIds.length}, total=${total}, search=${sanitizedSearch ?? 'none'})`,
                );
            }

            return {
                status: 'success',
                works: worksWithRoles,
                total,
                limit,
                offset,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'getting works');
        }
    }

    private shouldRecoverItemsCount(work: Work): boolean {
        if ((work.itemsCount ?? 0) > 0) {
            return false;
        }

        const status = work.generateStatus?.status;
        return (
            status === GenerateStatusType.GENERATING ||
            status === GenerateStatusType.ERROR ||
            status === GenerateStatusType.CANCELLED
        );
    }

    async getStats(user: User) {
        try {
            const memberWorkIds = await this.workMemberRepository.getAccessibleWorkIds(user.id);

            return await this.workRepository.getAccessibleStats({
                userId: user.id,
                memberWorkIds,
            });
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'getting work stats');
        }
    }

    async getWork(id: string, user: User) {
        try {
            const accessResult = await this.ownershipService.ensureAccess(id, user.id);
            const work = accessResult.work;
            work.owner = work.getRepoOwner();
            const websiteRepositoryInitialized = await this.websiteRepositoryState.isInitialized(
                work,
                user,
            );

            // Return work with user's role
            const workWithRole: WorkWithRole = {
                ...work,
                userRole: accessResult.role,
                websiteRepositoryInitialized,
            };

            return {
                status: 'success',
                work: workWithRole,
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'getting work');
        }
    }

    async workExists(slug: string, user: User) {
        return this.workRepository.existsByUserAndSlug(user.id, slug);
    }

    async workItems(workId: string, user: User) {
        // Any access level can view items
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        try {
            const items = await this.dataGenerator.getItems(work, user);
            return {
                status: 'success',
                items,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error('Failed to get work items:', error);

            const errMessage = normalizeGeneratorError(error);
            if (this.isReadOnlyRepoUnavailable(errMessage)) {
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

    async workConfig(workId: string, user: User) {
        // Any access level can view config
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        try {
            const config = await this.dataGenerator.getConfig(work, user);
            return {
                status: 'success',
                config,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            if (this.isReadOnlyRepoUnavailable(errMessage)) {
                return {
                    status: 'success',
                    config: null,
                };
            }

            this.logger.error('Failed to get work config:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async getWebsiteSettings(workId: string, user: User) {
        // Any access level can view settings
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);
        const defaultCompanyName = work.name || work.slug;

        try {
            const config = await this.dataGenerator.getConfig(work, user);
            return {
                status: 'success',
                company_name: config?.company_name || defaultCompanyName,
                company_website: config?.company_website || '',
                settings: config?.settings || {},
                custom_menu: config?.custom_menu || { header: [], footer: [] },
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            if (this.isReadOnlyRepoUnavailable(errMessage)) {
                return {
                    status: 'success',
                    company_name: defaultCompanyName,
                    company_website: '',
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
        workId: string,
        user: User,
        dto: {
            company_name?: string;
            company_website?: string;
            categories_enabled?: boolean;
            collections_enabled?: boolean;
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
        const { work } = await this.ownershipService.ensureCanEdit(workId, user.id);

        try {
            const { custom_menu, company_name, company_website, ...settings } = dto;
            await this.dataGenerator.updateWebsiteSettings(
                work,
                user,
                settings,
                custom_menu,
                company_name,
                company_website,
            );
            return {
                status: 'success',
                message: 'Website settings updated successfully',
            };
        } catch (error) {
            rethrowAsNormalized(error, this.logger, 'updating website settings');
        }
    }

    async workCount(workId: string, user: User) {
        // Any access level can view count
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        try {
            const count = await this.dataGenerator.count(work, user);
            return {
                status: 'success',
                ...count,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);
            if (this.isReadOnlyRepoUnavailable(errMessage)) {
                return {
                    status: 'success',
                    items: 0,
                    categories: 0,
                    tags: 0,
                };
            }

            this.logger.error('Failed to get work count:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async workCategoriesTags(workId: string, user: User) {
        // Any access level can view categories and tags
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        try {
            const { categories, tags, collections } = await this.dataGenerator.getCategoriesTags(
                work,
                user,
            );
            return {
                status: 'success',
                categories,
                tags,
                collections,
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }

            const errMessage = normalizeGeneratorError(error);

            if (this.isReadOnlyRepoUnavailable(errMessage)) {
                return {
                    status: 'success',
                    categories: [],
                    tags: [],
                    collections: [],
                };
            }

            this.logger.error('Failed to get work categories and tags:', error);

            throw new BadRequestException({
                status: 'error',
                message: errMessage,
            });
        }
    }

    async workGenerationHistory(
        workId: string,
        user: User,
        options: { limit?: number; offset?: number; activityType?: string } = {},
    ): Promise<WorkGenerationHistoryListDto> {
        // Any access level can view generation history
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);

        const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
        const offset = Math.max(options.offset ?? 0, 0);
        const activityTypes = this.resolveHistoryActivityTypes(options.activityType);

        const [history, total] = await Promise.all([
            this.generationHistoryRepository.findByWorkFiltered(
                work.id,
                limit,
                offset,
                activityTypes,
            ),
            this.generationHistoryRepository.countByWork(work.id, activityTypes),
        ]);

        return {
            history: history.map((record) => this.toGenerationHistoryDto(record)),
            total,
            limit,
            offset,
        };
    }

    private toGenerationHistoryDto(record: WorkGenerationHistory): WorkGenerationHistoryDto {
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
            activityType: record.activityType,
            changelog: record.changelog ?? null,
            logs: record.logs ?? null,
            warnings: record.warnings ?? null,
            triggeredBy: record.triggeredBy ?? null,
        };
    }

    private resolveHistoryActivityTypes(
        activityType?: string,
    ): WorkHistoryActivityType[] | undefined {
        switch (activityType) {
            case 'generation':
                return [WorkHistoryActivityType.GENERATION];
            case 'items':
                return [
                    WorkHistoryActivityType.ITEM_ADDED,
                    WorkHistoryActivityType.ITEM_UPDATED,
                    WorkHistoryActivityType.ITEM_REMOVED,
                ];
            case 'comparisons':
                return [
                    WorkHistoryActivityType.COMPARISON_ADDED,
                    WorkHistoryActivityType.COMPARISON_REMOVED,
                ];
            case 'taxonomy':
                return [
                    WorkHistoryActivityType.CATEGORY_CHANGE,
                    WorkHistoryActivityType.TAG_CHANGE,
                    WorkHistoryActivityType.COLLECTION_CHANGE,
                ];
            case 'community_pr':
                return [WorkHistoryActivityType.COMMUNITY_PR_MERGED];
            default:
                return undefined;
        }
    }

    private isReadOnlyRepoUnavailable(message: string): boolean {
        return (
            message.includes('Repository not found') ||
            message.includes('Please reconnect your Git account to continue.')
        );
    }
}
