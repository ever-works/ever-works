import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService, Directory } from '../../services/api.service';

export const listCommand = new Command('list')
    .description('List all directories')
    .option('--limit <limit>', 'Limit number of results', '20')
    .action(async (options) => {
        try {
            console.log(chalk.cyan.bold('\n📋 Directory List\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const spinner = ora('Loading directories...').start();

            try {
                const response = await apiService.getDirectories({
                    limit: options.limit ? parseInt(options.limit, 10) : undefined,
                });
                const directories: Directory[] = response.directories || [];

                spinner.succeed(`Found ${directories.length} directories`);

                if (directories.length === 0) {
                    console.log(chalk.yellow('\n⚠ No directories found.'));
                    console.log(
                        chalk.gray('Create your first directory with: ever-works directory create'),
                    );
                    return;
                }

                console.log(chalk.cyan('\nDirectories:'));
                console.log(chalk.gray('─'.repeat(80)));

                directories.forEach((dir, index) => {
                    console.log(chalk.white(`${index + 1}. ${dir.name}`));
                    console.log(chalk.gray(`   Slug: ${dir.slug}`));
                    console.log(
                        chalk.gray(
                            `   Owner: ${dir.owner}${dir.organization ? ' (Organization)' : ''}`,
                        ),
                    );
                    console.log(chalk.gray(`   Description: ${dir.description}`));
                    if (dir.website) {
                        console.log(chalk.blue(`   Website: ${dir.website}`));
                    }
                    console.log('');
                });

                console.log(chalk.gray('─'.repeat(80)));
                console.log(chalk.cyan(`Total: ${directories.length} directories`));
            } catch (error) {
                spinner.fail('Failed to load directories');
                throw error;
            }
        } catch (error) {
            console.error(
                chalk.red('\n✗ Failed to list directories:'),
                error.response?.data?.message || error.message,
            );

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            }

            process.exit(1);
        }
    });
