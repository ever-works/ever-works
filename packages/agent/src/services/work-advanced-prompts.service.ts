import { Injectable } from '@nestjs/common';
import { WorkAdvancedPromptsRepository } from '@src/database/repositories/work-advanced-prompts.repository';
import { WorkOwnershipService } from './work-ownership.service';
import {
    UpdateWorkAdvancedPromptsDto,
    WorkAdvancedPromptsResponseDto,
} from '@src/dto/work-advanced-prompts.dto';
import { WorkAdvancedPrompts } from '@src/entities/work-advanced-prompts.entity';

/**
 * Service for managing per-work advanced prompts.
 * These prompts are appended to the standard hardcoded prompts during work generation.
 */
@Injectable()
export class WorkAdvancedPromptsService {
    constructor(
        private readonly repository: WorkAdvancedPromptsRepository,
        private readonly ownershipService: WorkOwnershipService,
    ) {}

    /**
     * Get advanced prompts for a work (with access check).
     */
    async getAdvancedPrompts(
        workId: string,
        userId: string,
    ): Promise<WorkAdvancedPromptsResponseDto> {
        // Ensure user has at least viewer access to the work
        await this.ownershipService.ensureAccess(workId, userId);

        const prompts = await this.repository.findByWorkId(workId);

        return this.toResponseDto(workId, prompts);
    }

    /**
     * Update advanced prompts for a work (requires editor role).
     */
    async updateAdvancedPrompts(
        workId: string,
        dto: UpdateWorkAdvancedPromptsDto,
        userId: string,
    ): Promise<WorkAdvancedPromptsResponseDto> {
        // Require editor role to modify advanced prompts
        await this.ownershipService.ensureCanEdit(workId, userId);

        const prompts = await this.repository.createOrUpdate(workId, {
            relevanceAssessment: dto.relevanceAssessment,
            itemGeneration: dto.itemGeneration,
            itemExtraction: dto.itemExtraction,
            searchQuery: dto.searchQuery,
            categorization: dto.categorization,
            deduplication: dto.deduplication,
            sourceValidation: dto.sourceValidation,
        });

        return this.toResponseDto(workId, prompts);
    }

    /**
     * Get prompts for generation pipeline (internal use, no auth).
     * Used by ItemsGeneratorService to load prompts during generation.
     */
    async getPromptsForGeneration(workId: string): Promise<WorkAdvancedPrompts | null> {
        return this.repository.findByWorkId(workId);
    }

    /**
     * Delete advanced prompts for a work.
     * Called when a work is deleted (via cascade) or can be called to reset prompts.
     */
    async deleteAdvancedPrompts(workId: string, userId: string): Promise<boolean> {
        await this.ownershipService.ensureCanEdit(workId, userId);
        return this.repository.delete(workId);
    }

    private toResponseDto(
        workId: string,
        prompts: WorkAdvancedPrompts | null,
    ): WorkAdvancedPromptsResponseDto {
        return {
            workId,
            relevanceAssessment: prompts?.relevanceAssessment ?? null,
            itemGeneration: prompts?.itemGeneration ?? null,
            itemExtraction: prompts?.itemExtraction ?? null,
            searchQuery: prompts?.searchQuery ?? null,
            categorization: prompts?.categorization ?? null,
            deduplication: prompts?.deduplication ?? null,
            sourceValidation: prompts?.sourceValidation ?? null,
            updatedAt: prompts?.updatedAt?.toISOString() ?? null,
        };
    }
}
