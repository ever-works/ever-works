import chalk from 'chalk';
import {
    WorkPromptService as BaseWorkPromptService,
    WorkSelection,
    WorkMemberRole,
} from '@ever-works/cli-shared';
import { getApiService } from '../../services/api.service';

// Re-export types from shared package for convenience
export type {
    WorkInputData,
    MarkdownReadmeConfigDto,
    SlugConflictResolution,
    WorkSelection,
    Work,
    GitProviderChoice,
    DeployProviderChoice,
} from '@ever-works/cli-shared';

export { WorkMemberRole, GenerateStatusType } from '@ever-works/cli-shared';

/**
 * Check if the user's role allows editing (editor, manager, or owner).
 */
export function canEdit(role?: WorkMemberRole | string): boolean {
    return (
        !!role &&
        [
            WorkMemberRole.OWNER,
            WorkMemberRole.MANAGER,
            WorkMemberRole.EDITOR,
        ].includes(role as WorkMemberRole)
    );
}

/**
 * Check if the user's role allows deletion (owner only).
 */
export function canDelete(role?: WorkMemberRole | string): boolean {
    return role === WorkMemberRole.OWNER;
}

export class WorkPromptService extends BaseWorkPromptService {
    private apiService = getApiService();

    /**
     * Override the base implementation to handle API-based work selection
     */
    async promptWorkSelection(): Promise<WorkSelection> {
        try {
            // Fetch works from API
            const response = await this.apiService.getWorks({ limit: 50 });
            const works = response.works || [];

            // Use the base class implementation with the fetched works
            return super.promptWorkSelection(works);
        } catch (error) {
            console.error(chalk.red('Error fetching works:'), error.message);

            // Fallback to manual slug entry
            console.log(chalk.yellow('\n⚠ Could not fetch works from API.'));

            return { work: null, cancelled: true };
        }
    }

    /**
     * Generate an incremented slug for conflict resolution
     */
    generateIncrementedSlug(baseSlug: string, increment: number): string {
        return `${baseSlug}-${increment}`;
    }
}
