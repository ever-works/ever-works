import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository, UserRepository } from '@packages/agent/database';
import { VercelService } from '@packages/agent/deploy';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';

@SubCommand({
    name: 'deploy',
    description: 'Deploy the website for a directory',
})
export class DeploySubCommand extends CommandRunner {
    private readonly logger = new Logger(DeploySubCommand.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryPrompt: DirectoryPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly vercelService: VercelService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\n🚀 Deploy Website\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Select directory
            const selection = await this.directoryPrompt.promptDirectorySelection(
                this.directoryRepository,
            );
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const directory = selection.directory;
            console.log(chalk.green(`\n✓ Selected directory: ${directory.slug}`));

            // Prompt for deployment options
            const deployOptions = await this.promptDeployOptions();
            const vercelTeam = await this.promptVercelTeamSelection(
                deployOptions.VERCEL_TOKEN || process.env.VERCEL_TOKEN,
            );

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

            if (vercelTeam) {
                console.log(chalk.gray('Vercel team:'), chalk.white(vercelTeam.label));
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

            // Deploy website
            const spinner = ora('Deploying website...').start();

            try {
                // Get user and call the service method directly
                const user = await this.userRepository.createOrGetLocalUser();

                // Call the vercel service
                await this.vercelService.deploy(
                    {
                        owner: directory.getRepoOwner(),
                        repo: directory.getWebsiteRepo(),
                        provider: 'vercel',
                        data: {
                            vercelTeamId: vercelTeam?.id,
                            vercelToken: deployOptions.VERCEL_TOKEN || process.env.VERCEL_TOKEN,
                            ghToken: deployOptions.GITHUB_TOKEN || process.env.GH_APIKEY,
                        },
                    },
                    directory,
                    user,
                );

                spinner.stop();

                console.log(chalk.green('\n✓ Website deployment initiated successfully!'));
                console.log(
                    chalk.gray('Repository:'),
                    chalk.white(`${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`),
                );

                console.log(chalk.cyan('\n--- Next Steps ---'));
                console.log(chalk.gray('  • Check Vercel dashboard for deployment status'));
                console.log(chalk.gray('  • Monitor GitHub Actions for workflow progress'));
                console.log(
                    chalk.gray('  • The website will be available once deployment completes'),
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

        const { VERCEL_TOKEN } = await inquirer.prompt([
            {
                type: 'password',
                name: 'VERCEL_TOKEN',
                message: 'Vercel Token (optional):',
                mask: '*',
            },
        ]);

        const { GITHUB_TOKEN } = await inquirer.prompt([
            {
                type: 'password',
                name: 'GITHUB_TOKEN',
                message: 'GitHub Token (optional):',
                mask: '*',
            },
        ]);

        return {
            VERCEL_TOKEN: VERCEL_TOKEN.trim() || undefined,
            GITHUB_TOKEN: GITHUB_TOKEN.trim() || undefined,
        };
    }

    private async promptVercelTeamSelection(
        tokenFromInput?: string,
    ): Promise<{ id: string; label: string } | undefined> {
        const token = tokenFromInput || process.env.VERCEL_TOKEN;
        if (!token) {
            return undefined;
        }

        try {
            const teams = await this.vercelService.getAccountTeams(token);
            if (!Array.isArray(teams) || teams.length === 0) {
                return undefined;
            }

            console.log(chalk.cyan('\n--- Vercel Team Selection ---'));

            const choices = teams.map((team: any) => ({
                name: team.name ? `${team.name} (${team.slug})` : team.slug,
                value: team.id,
            }));

            const { vercelTeamId } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'vercelTeamId',
                    message: 'Select the Vercel team to deploy to:',
                    choices,
                    loop: false,
                },
            ]);

            const selected = choices.find((choice) => choice.value === vercelTeamId);
            console.log(chalk.green(`\n✓ Selected Vercel team: ${selected?.name || vercelTeamId}`));

            return {
                id: vercelTeamId,
                label: selected?.name || vercelTeamId,
            };
        } catch (error: any) {
            this.logger.warn(`Unable to fetch Vercel teams: ${error?.message || error}`);
            console.log(
                chalk.yellow(
                    '\n⚠ Could not retrieve Vercel teams. Continuing without team selection.',
                ),
            );
            return undefined;
        }
    }
}
