import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';
import { DirectoryPromptService } from './directory-prompt.service';

interface CreateDirectoryDto {
    slug: string;
    name: string;
    description: string;
    owner?: string;
    readme_config?: {
        header?: string;
        overwrite_default_header?: boolean;
        footer?: string;
        overwrite_default_footer?: boolean;
    };
}

export const createCommand = new Command('create')
    .description('Create a new directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n📁 Create New Directory\n'));

            // Ensure user is authenticated
            await requireAuth();

            const httpClient = getHttpClient();
            const directoryPrompt = new DirectoryPromptService();

            // Show loading message
            const loadingSpinner = ora('Loading...').start();
            
            // TODO: Get user information from API when available
            // For now, we'll use a placeholder
            const defaultOwner = 'user'; // This should come from API
            
            loadingSpinner.stop();

            // Collect directory information
            const directoryData = await directoryPrompt.promptDirectoryCreation(defaultOwner);

            // Check for slug conflicts and handle them
            let finalSlug = directoryData.slug;
            let conflictResolved = false;
            let increment = 1;

            while (!conflictResolved) {
                const spinner = ora(`Checking availability of slug: "${finalSlug}"`).start();

                try {
                    // Try to create the directory
                    const createDirectoryDto: CreateDirectoryDto = {
                        slug: finalSlug,
                        name: directoryData.name,
                        description: directoryData.description,
                        owner: directoryData.owner,
                        readme_config: directoryData.readme_config
                    };

                    const response = await httpClient.post('/directories', createDirectoryDto);
                    
                    spinner.succeed('Directory created successfully');
                    conflictResolved = true;

                    console.log(chalk.green('\n✓ Directory created successfully!'));
                    console.log(chalk.gray('Directory details:'));
                    console.log(chalk.white(`  Name: ${response.data.directory.name}`));
                    console.log(chalk.white(`  Slug: ${response.data.directory.slug}`));
                    console.log(chalk.white(`  Owner: ${response.data.directory.owner}`));
                    console.log(chalk.white(`  Description: ${response.data.directory.description}`));

                    console.log(chalk.cyan('\nNext Steps:'));
                    console.log(
                        chalk.gray('  • Use ') +
                        chalk.cyan('directory generate') +
                        chalk.gray(' to generate content for your directory.')
                    );
                    console.log(chalk.gray('  • Start adding content to your new directory'));

                } catch (error) {
                    spinner.stop();

                    // Check if it's a conflict error (assuming API returns 409 or similar)
                    if (error.response?.status === 409 || error.message.includes('already exists')) {
                        const suggestedSlug = directoryPrompt.generateIncrementedSlug(directoryData.slug, increment);
                        
                        const resolution = await directoryPrompt.promptSlugConflictResolution(finalSlug, suggestedSlug);
                        
                        if (resolution.action === 'cancel') {
                            console.log(chalk.yellow('\n⚠ Directory creation cancelled.'));
                            return;
                        } else if (resolution.action === 'use_suggested') {
                            finalSlug = suggestedSlug;
                            increment++;
                        } else if (resolution.action === 'modify' && resolution.finalSlug) {
                            finalSlug = resolution.finalSlug;
                            increment = 1; // Reset increment for new base slug
                        }

                        console.log(chalk.green(`✓ Using slug: "${finalSlug}"`));
                    } else {
                        // Other error
                        throw error;
                    }
                }
            }

        } catch (error) {
            console.error(chalk.red('\n✗ Failed to create directory:'), error.response?.data?.message || error.message);

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            } else if (error.response?.status === 400) {
                console.log(chalk.yellow('\n⚠ Invalid input. Please check your data and try again.'));
            }

            process.exit(1);
        }
    });
