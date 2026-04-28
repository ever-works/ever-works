import { Injectable } from '@nestjs/common';
import type { ParsedWorksConfig, ResolvedWorksConfig } from './works-config.service';
import { Directory, type RepositoryTarget } from '@src/entities/directory.entity';
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
        directoryId: string,
        userId: string,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        await this.applier.applyPipelineSettings(directoryId, userId, worksConfig);
    }

    async applyInitialSchedule(
        directoryId: string,
        user: User,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        await this.applier.applyInitialSchedule(directoryId, user, worksConfig);
    }

    async applyScheduleOverrides(
        directory: Directory,
        user: User,
        worksConfig?: ParsedWorksConfig | ResolvedWorksConfig | null,
    ): Promise<void> {
        await this.applier.applyScheduleOverrides(directory, user, worksConfig);
    }
}
