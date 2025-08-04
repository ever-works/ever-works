import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';

interface DeployDto {
    VERCEL_TOKEN?: string;
    GITHUB_TOKEN?: string;
}

export const deployCommand = new Command('deploy')
    .description('Deploy the website for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n🚀 Deploy Website\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const directoryPrompt = new DirectoryPromptService();

            // Select directory
            const selection = await directoryPrompt.promptDirectorySelection();
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const directory = selection.directory;
            console.log(chalk.green(`\n✓ Selected directory: ${directory.slug}`));

            // Prompt for deployment options
            const deployOptions = await inquirer.prompt([
                {
                    type: 'password',
                    name: 'VERCEL_TOKEN',
                    message:
                        'Vercel Token (optional, will use environment variable if not provided):',
                    mask: '*',
                },
                {
                    type: 'password',
                    name: 'GITHUB_TOKEN',
                    message:
                        'GitHub Token (optional, will use environment variable if not provided):',
                    mask: '*',
                },
            ]);

            // Show information about what will happen
            console.log(chalk.cyan('\n--- Deployment Process ---'));
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Deploy the website to Vercel'));
            console.log(chalk.gray('  • Update the website repository if needed'));
            console.log(chalk.gray('  • Trigger the deployment workflow'));

            const websiteRepo = `${directory.slug}-website`;
            console.log(
                chalk.gray('\nSource repository:'),
                chalk.white(`${directory.getRepoOwner()}/${websiteRepo}`),
            );

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with deployment?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Deployment cancelled.'));
                return;
            }

            // Deploy website
            const spinner = ora('Deploying website...').start();

            try {
                const deployDto: DeployDto = {};

                if (deployOptions.VERCEL_TOKEN) {
                    deployDto.VERCEL_TOKEN = deployOptions.VERCEL_TOKEN;
                }

                if (deployOptions.GITHUB_TOKEN) {
                    deployDto.GITHUB_TOKEN = deployOptions.GITHUB_TOKEN;
                }

                await apiService.deployWebsite(directory.slug, deployDto);

                spinner.succeed('Deployment started successfully');

                console.log(chalk.green('\n✓ Deployment started successfully!'));
                console.log(chalk.gray('The deployment process has been initiated.'));

                console.log(chalk.cyan('\nNext Steps:'));
                console.log(
                    chalk.gray('  • Monitor the deployment progress in your Vercel dashboard'),
                );
                console.log(chalk.gray('  • Check the GitHub Actions for deployment status'));
                console.log(chalk.gray('  • Visit your website once deployment is complete'));

                if (directory.website) {
                    console.log(chalk.blue('\nWebsite URL:'), chalk.white(directory.website));
                }
            } catch (error) {
                spinner.fail('Deployment failed');
                throw error;
            }
        } catch (error) {
            console.error(
                chalk.red('\n✗ Failed to deploy website:'),
                error.response?.data?.message || error.message,
            );

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            } else if (error.response?.status === 404) {
                console.log(
                    chalk.yellow('\n⚠ Directory not found. Please check the slug and try again.'),
                );
            } else if (error.response?.status === 400) {
                console.log(
                    chalk.yellow(
                        '\n⚠ Invalid deployment configuration. Please check your tokens and try again.',
                    ),
                );
            }

            process.exit(1);
        }
    });
