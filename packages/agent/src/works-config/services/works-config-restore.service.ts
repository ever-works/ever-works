import { Injectable } from '@nestjs/common';
import type { ParsedWorksConfig, ResolvedWorksConfig } from './works-config.service';
import { Work, type RepositoryTarget } from '@src/entities/work.entity';
import { User } from '@src/entities/user.entity';
import {
    WorksConfigImportPlannerService,
    type WorksConfigSourceRepositoryOptions,
} from './works-config-import-planner.service';
import { WorksConfigImportApplierService } from './works-config-import-applier.service';

@Injectable()
export class WorksConfigRestoreService {
    constructor(
        private readonly planner: WorksConfigImportPlannerService,
        private readonly applier: WorksConfigImportApplierService,
    ) {}

    toSnapshot(worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null) {
        return this.planner.toSnapshot(worksConfig);
    }

    toResolved(worksConfig?: ParsedWorksConfig | null): ResolvedWorksConfig | null {
        return this.planner.toResolved(worksConfig);
    }

    getConflictRepoNames(
        slug: string,
        sourceRepoName?: string | null,
        worksConfig?: { websiteRepo?: string } | null,
    ): string[] {
        return this.planner.getConflictRepoNames(slug, sourceRepoName, worksConfig);
    }

    sanitizeConflict(
        conflict: {
            hasConflict: boolean;
            conflictingRepos: string[];
            suggestedSlug: string;
        },
        sourceRepoName?: string | null,
        worksConfig?: { websiteRepo?: string } | null,
    ) {
        return this.planner.sanitizeConflict(conflict, sourceRepoName, worksConfig);
    }

    async validateForImport(worksConfig: ParsedWorksConfig | null, userId: string): Promise<void> {
        await this.planner.validateForGeneratedImport(worksConfig, userId);
    }

    async validateProviderSettings(
        worksConfig: ParsedWorksConfig | ResolvedWorksConfig | null,
        userId: string,
        options?: { validateDefaults?: boolean },
    ): Promise<void> {
        await this.planner.validateProviderSettings(worksConfig, userId, options);
    }

    validateRepositoryTargets(
        source: RepositoryTarget,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): void {
        this.planner.validateRepositoryTargets(source, worksConfig);
    }

    buildSourceRepository(options: WorksConfigSourceRepositoryOptions) {
        return this.planner.buildSourceRepository(options);
    }

    async applyPipelineSettings(
        workId: string,
        userId: string,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        await this.applier.applyPipelineSettings(workId, userId, worksConfig);
    }

    async applyInitialSchedule(
        workId: string,
        user: User,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        await this.applier.applyInitialSchedule(workId, user, worksConfig);
    }

    async applyScheduleOverrides(
        work: Work,
        user: User,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        await this.applier.applyScheduleOverrides(work, user, worksConfig);
    }

    async applyActivitySyncMode(
        workId: string,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        await this.applier.applyActivitySyncMode(workId, worksConfig);
    }
}
