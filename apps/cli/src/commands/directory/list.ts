import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
// import { getHttpClient } from '../../services/http-client'; // Will be used when API endpoint is available

// Interface for when the API endpoint is implemented
// interface Directory {
//     id: number;
//     name: string;
//     slug: string;
//     website?: string;
//     owner: string;
//     companyName?: string;
//     organization: boolean;
//     description: string;
// }

export const listCommand = new Command('list')
    .description('List all directories')
    .option('--owner <owner>', 'Filter by owner')
    .option('--limit <limit>', 'Limit number of results', '20')
    .action(async (_options) => {
        try {
            console.log(chalk.cyan.bold('\n📋 Directory List\n'));

            // Ensure user is authenticated
            await requireAuth();

            // const httpClient = getHttpClient(); // Will be used when API endpoint is available
            const spinner = ora('Loading directories...').start();

            try {
                // Note: This endpoint doesn't exist yet in agent-http.controller
                // We'll need to add it or use a different approach
                console.log(chalk.yellow('\n⚠ Directory listing endpoint not yet implemented in API.'));
                console.log(chalk.gray('This feature will be available once the API endpoint is added.'));
                
                spinner.stop();
                
                // Placeholder implementation
                console.log(chalk.gray('\nTo list directories, you can:'));
                console.log(chalk.gray('  1. Check your GitHub repositories'));
                console.log(chalk.gray('  2. Use the web interface'));
                console.log(chalk.gray('  3. Contact support for assistance'));
                
                console.log(chalk.cyan('\nAlternatively, if you know the directory slug:'));
                console.log(chalk.gray('  Use other directory commands with the specific slug'));

                // TODO: Implement when API endpoint is available
                /*
                const queryParams = new URLSearchParams();
                if (options.owner) queryParams.append('owner', options.owner);
                if (options.limit) queryParams.append('limit', options.limit);
                
                const response = await httpClient.get(`/directories?${queryParams.toString()}`);
                const directories: Directory[] = response.data.directories || [];

                spinner.succeed(`Found ${directories.length} directories`);

                if (directories.length === 0) {
                    console.log(chalk.yellow('\n⚠ No directories found.'));
                    console.log(chalk.gray('Create your first directory with: ever-works directory create'));
                    return;
                }

                console.log(chalk.cyan('\nDirectories:'));
                console.log(chalk.gray('─'.repeat(80)));

                directories.forEach((dir, index) => {
                    console.log(chalk.white(`${index + 1}. ${dir.name}`));
                    console.log(chalk.gray(`   Slug: ${dir.slug}`));
                    console.log(chalk.gray(`   Owner: ${dir.owner}${dir.organization ? ' (Organization)' : ''}`));
                    console.log(chalk.gray(`   Description: ${dir.description}`));
                    if (dir.website) {
                        console.log(chalk.blue(`   Website: ${dir.website}`));
                    }
                    console.log('');
                });

                console.log(chalk.gray('─'.repeat(80)));
                console.log(chalk.cyan(`Total: ${directories.length} directories`));
                */

            } catch (error) {
                spinner.fail('Failed to load directories');
                throw error;
            }

        } catch (error) {
            console.error(chalk.red('\n✗ Failed to list directories:'), error.response?.data?.message || error.message);

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            }

            process.exit(1);
        }
    });
