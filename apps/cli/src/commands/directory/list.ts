import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { Directory, DirectoryMemberRole } from '@ever-works/cli-shared';
import { handleCliError } from '../../utils/error';

export const listCommand = new Command('list')
    .description('List all directories')
    .option('--limit <limit>', 'Limit number of results', '20')
    .action(async (options) => {
        try {
            console.log(chalk.cyan.bold('\nDirectory List\n'));

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
                console.log(chalk.gray('─'.repeat(50)));

                const ownedCount = directories.filter(
                    (d) => d.userRole === DirectoryMemberRole.OWNER || !d.userRole,
                ).length;
                const sharedCount = directories.length - ownedCount;

                directories.forEach((dir, index) => {
                    const role = dir.userRole || DirectoryMemberRole.OWNER;
                    const isShared = role !== DirectoryMemberRole.OWNER;
                    const roleLabel = isShared
                        ? chalk.magenta(`[${role}]`)
                        : chalk.gray(`[${role}]`);

                    console.log(chalk.white(`${index + 1}. ${dir.name} ${roleLabel}`));
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

                console.log(chalk.gray('─'.repeat(50)));
                console.log(
                    chalk.cyan(`Total: ${directories.length} directories`) +
                        chalk.gray(` (${ownedCount} owned, ${sharedCount} shared with you)`),
                );
            } catch (error) {
                spinner.fail('Failed to load directories');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
