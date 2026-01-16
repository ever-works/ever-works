import { Injectable } from '@nestjs/common';
import { DirectoryAdvancedPromptsRepository } from '@src/database/repositories/directory-advanced-prompts.repository';
import { DirectoryOwnershipService } from './directory-ownership.service';
import {
    UpdateDirectoryAdvancedPromptsDto,
    DirectoryAdvancedPromptsResponseDto,
} from '@src/dto/directory-advanced-prompts.dto';
import { DirectoryAdvancedPrompts } from '@src/entities/directory-advanced-prompts.entity';

/**
 * Service for managing per-directory advanced prompts.
 * These prompts are appended to the standard hardcoded prompts during directory generation.
 */
@Injectable()
export class DirectoryAdvancedPromptsService {
    constructor(
        private readonly repository: DirectoryAdvancedPromptsRepository,
        private readonly ownershipService: DirectoryOwnershipService,
    ) {}

    /**
     * Get advanced prompts for a directory (with access check).
     */
    async getAdvancedPrompts(
        directoryId: string,
        userId: string,
    ): Promise<DirectoryAdvancedPromptsResponseDto> {
        // Ensure user has at least viewer access to the directory
        await this.ownershipService.ensureAccess(directoryId, userId);

        const prompts = await this.repository.findByDirectoryId(directoryId);

        return this.toResponseDto(directoryId, prompts);
    }

    /**
     * Update advanced prompts for a directory (requires editor role).
     */
    async updateAdvancedPrompts(
        directoryId: string,
        dto: UpdateDirectoryAdvancedPromptsDto,
        userId: string,
    ): Promise<DirectoryAdvancedPromptsResponseDto> {
        // Require editor role to modify advanced prompts
        await this.ownershipService.ensureCanEdit(directoryId, userId);

        const prompts = await this.repository.createOrUpdate(directoryId, {
            relevanceAssessment: dto.relevanceAssessment,
            itemGeneration: dto.itemGeneration,
            itemExtraction: dto.itemExtraction,
            searchQuery: dto.searchQuery,
            categorization: dto.categorization,
            deduplication: dto.deduplication,
            sourceValidation: dto.sourceValidation,
        });

        return this.toResponseDto(directoryId, prompts);
    }

    /**
     * Get prompts for generation pipeline (internal use, no auth).
     * Used by ItemsGeneratorService to load prompts during generation.
     */
    async getPromptsForGeneration(directoryId: string): Promise<DirectoryAdvancedPrompts | null> {
        return this.repository.findByDirectoryId(directoryId);
    }

    /**
     * Delete advanced prompts for a directory.
     * Called when a directory is deleted (via cascade) or can be called to reset prompts.
     */
    async deleteAdvancedPrompts(directoryId: string, userId: string): Promise<boolean> {
        await this.ownershipService.ensureCanEdit(directoryId, userId);
        return this.repository.delete(directoryId);
    }

    private toResponseDto(
        directoryId: string,
        prompts: DirectoryAdvancedPrompts | null,
    ): DirectoryAdvancedPromptsResponseDto {
        return {
            directoryId,
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
