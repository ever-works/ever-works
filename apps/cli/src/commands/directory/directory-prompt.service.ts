import chalk from 'chalk';
import inquirer from 'inquirer';
import {
    DirectoryPromptService as BaseDirectoryPromptService,
    DirectorySelection,
    Directory
} from '@packages/cli-shared';
import { getApiService } from '../../services/api.service';

// Re-export types from shared package for convenience
export type { DirectoryInputData, MarkdownReadmeConfigDto, SlugConflictResolution, DirectorySelection, Directory } from '@packages/cli-shared';

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
            console.log(chalk.gray('Please enter the directory slug manually:'));

            const answer = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'slug',
                    message: 'Directory slug:',
                    validate: (input) => input.trim().length > 0 || 'Directory slug is required'
                }
            ]);

            // Mock directory object for fallback
            const directory: Directory = {
                id: 1,
                name: answer.slug,
                slug: answer.slug,
                owner: 'unknown',
                organization: false,
                description: 'Directory selected by slug'
            };

            return { directory, cancelled: false };
        }
    }
}
