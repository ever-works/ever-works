import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { Work, WorkMemberRole } from './work-prompt.service';
import { handleCliError } from '../../utils/error';

export const listCommand = new Command('list')
    .description('List all works')
    .option('--limit <limit>', 'Limit number of results', '20')
    .action(async (options) => {
        try {
            console.log(chalk.cyan.bold('\nWork List\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const spinner = ora('Loading works...').start();

            try {
                const response = await apiService.getWorks({
                    limit: options.limit ? parseInt(options.limit, 10) : undefined,
                });
                const works: Work[] = response.works || [];

                spinner.succeed(`Found ${works.length} works`);

                if (works.length === 0) {
                    console.log(chalk.yellow('\n⚠ No works found.'));
                    console.log(
                        chalk.gray('Create your first work with: ever-works work create'),
                    );
                    return;
                }

                console.log(chalk.cyan('\nWorks:'));
                console.log(chalk.gray('─'.repeat(50)));

                const ownedCount = works.filter(
                    (d) => d.userRole === WorkMemberRole.OWNER || !d.userRole,
                ).length;
                const sharedCount = works.length - ownedCount;

                works.forEach((dir, index) => {
                    const role = dir.userRole || WorkMemberRole.OWNER;
                    const isShared = role !== WorkMemberRole.OWNER;
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
                    chalk.cyan(`Total: ${works.length} works`) +
                        chalk.gray(` (${ownedCount} owned, ${sharedCount} shared with you)`),
                );
            } catch (error) {
                spinner.fail('Failed to load works');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
