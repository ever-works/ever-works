import chalk from 'chalk';
import {
    DirectoryPromptService as BaseDirectoryPromptService,
    DirectorySelection,
} from '@ever-works/cli-shared';
import { getApiService } from '../../services/api.service';

// Re-export types from shared package for convenience
export type {
    DirectoryInputData,
    MarkdownReadmeConfigDto,
    SlugConflictResolution,
    DirectorySelection,
    Directory,
    GitProviderChoice,
    DeployProviderChoice,
} from '@ever-works/cli-shared';

export { DirectoryMemberRole } from '@ever-works/cli-shared';

export class DirectoryPromptService extends BaseDirectoryPromptService {
    private apiService = getApiService();

    /**
     * Override the base implementation to handle API-based directory selection
     */
    async promptDirectorySelection(): Promise<DirectorySelection> {
        try {
            // Fetch directories from API
            const response = await this.apiService.getDirectories({ limit: 50 });
            const directories = response.directories || [];

            // Use the base class implementation with the fetched directories
            return super.promptDirectorySelection(directories);
        } catch (error) {
            console.error(chalk.red('Error fetching directories:'), error.message);

            // Fallback to manual slug entry
            console.log(chalk.yellow('\n⚠ Could not fetch directories from API.'));

            return { directory: null, cancelled: true };
        }
    }

    /**
     * Generate an incremented slug for conflict resolution
     */
    generateIncrementedSlug(baseSlug: string, increment: number): string {
        return `${baseSlug}-${increment}`;
    }
}
