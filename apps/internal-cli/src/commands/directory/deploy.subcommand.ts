import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository, UserRepository } from '@packages/agent/database';
import { VercelApiService } from '@ever-works/vercel-plugin';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';

@SubCommand({
    name: 'deploy',
    description: 'Deploy the website for a directory',
})
export class DeploySubCommand extends CommandRunner {
    private readonly logger = new Logger(DeploySubCommand.name);
    private readonly deployApi = new VercelApiService();

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryPrompt: DirectoryPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\n🚀 Deploy Website\n'));

            await this.configCheck.requireConfiguration();

            const selection = await this.directoryPrompt.promptDirectorySelection(
                this.directoryRepository,
            );
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const directory = selection.directory;
            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected directory: ${this.directoryPrompt.formatSelectedDirectory(directory, role, isShared)}`,
                ),
            );

            const deployOptions = await this.promptDeployOptions();
            const team = await this.promptTeamSelection(
                deployOptions.DEPLOY_TOKEN || process.env.DEPLOY_TOKEN,
            );

            console.log(chalk.cyan('\n--- Deployment Process ---'));
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Deploy the website'));
            console.log(chalk.gray('  • Update the website repository if needed'));
            console.log(chalk.gray('  • Trigger the deployment workflow'));

            const websiteRepo = `${directory.slug}-website`;
            console.log(
                chalk.gray('\nSource repository:'),
                chalk.white(`${directory.getRepoOwner()}/${websiteRepo}`),
            );

            if (team) {
                console.log(chalk.gray('Team:'), chalk.white(team.label));
            }

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

            const spinner = ora('Deploying website...').start();

            try {
                const deployToken = deployOptions.DEPLOY_TOKEN || process.env.DEPLOY_TOKEN;

                if (!deployToken) {
                    throw new Error(
                        'Deploy token is required. Provide it via prompt or DEPLOY_TOKEN environment variable.',
                    );
                }

                const isValid = await this.deployApi.validateToken(deployToken);
                if (!isValid) {
                    throw new Error('Invalid deployment token');
                }

                spinner.stop();

                console.log(chalk.yellow('\n⚠ Direct CLI deployment is not available.'));
                console.log(chalk.cyan('\n--- Alternative Deployment Options ---'));
                console.log(chalk.gray('1. Use the web dashboard to deploy your directory'));
                console.log(chalk.gray('2. Push to your repository to trigger CI/CD deployment'));

                console.log(chalk.cyan('\n--- Repository Information ---'));
                console.log(
                    chalk.gray('Repository:'),
                    chalk.white(`${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`),
                );
                console.log(
                    chalk.gray('Clone command:'),
                    chalk.white(
                        `git clone https://github.com/${directory.getRepoOwner()}/${directory.getWebsiteRepo()}.git`,
                    ),
                );
            } catch (error) {
                spinner.stop();
                throw error;
            }
        } catch (error) {
            handleCliError(error, 'Failed to deploy website');
            process.exit(1);
        }
    }

    private async promptDeployOptions() {
        console.log(chalk.cyan('\n--- Deployment Options ---'));
        console.log(chalk.gray('Leave empty to use environment variables'));

        const answers = await inquirer.prompt([
            {
                type: 'password',
                name: 'DEPLOY_TOKEN',
                message: 'Deploy Token (optional):',
                mask: '*',
            },
        ]);

        return {
            DEPLOY_TOKEN: answers.DEPLOY_TOKEN.trim() || undefined,
        };
    }

    private async promptTeamSelection(
        tokenFromInput?: string,
    ): Promise<{ scope: string; label: string } | undefined> {
        const token = tokenFromInput || process.env.DEPLOY_TOKEN;
        if (!token) {
            return undefined;
        }

        try {
            const teams = await this.deployApi.getTeams(token);
            if (!Array.isArray(teams) || teams.length === 0) {
                return undefined;
            }

            console.log(chalk.cyan('\n--- Team Selection ---'));

            const choices = teams.map((team) => ({
                name: team.name ? `${team.name} (${team.slug})` : team.slug,
                value: team.slug,
            }));

            const { teamScope } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'teamScope',
                    message: 'Select the team to deploy to:',
                    choices,
                    loop: false,
                },
            ]);

            const selected = choices.find((choice) => choice.value === teamScope);
            console.log(chalk.green(`\n✓ Selected team: ${selected?.name || teamScope}`));

            return {
                scope: teamScope,
                label: selected?.name || teamScope,
            };
        } catch (error: any) {
            this.logger.warn(`Unable to fetch teams: ${error?.message || error}`);
            console.log(
                chalk.yellow('\n⚠ Could not retrieve teams. Continuing without team selection.'),
            );
            return undefined;
        }
    }
}
