import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository, UserRepository } from '@packages/agent/database';
import { DirectoryGenerationService } from '@packages/agent/services';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';

@SubCommand({
    name: 'regenerate-markdown',
    description: 'Regenerate markdown files for a directory',
})
export class RegenerateMarkdownSubCommand extends CommandRunner {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryPrompt: DirectoryPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly directoryGenerationService: DirectoryGenerationService,
        private readonly userRepository: UserRepository,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nRegenerate Markdown Files\n'));

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
            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected directory: ${this.directoryPrompt.formatSelectedDirectory(directory, role, isShared)}`,
                ),
            );

            // Show information about what will happen
            console.log(chalk.cyan('\n--- Regeneration Process ---'));
            console.log(chalk.gray('This will:'));
            console.log(chalk.gray('  • Regenerate README.md files'));
            console.log(chalk.gray('  • Update item detail pages'));
            console.log(chalk.gray('  • Sync with the latest data'));
            console.log(chalk.gray('  • Commit changes to the repository'));

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with markdown regeneration?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Regeneration cancelled.'));
                return;
            }

            // Regenerate markdown
            const spinner = ora('Regenerating markdown files...').start();

            try {
                const user = await this.userRepository.createOrGetLocalUser();

                // Call the agent service method directly
                const result = await this.directoryGenerationService.regenerateMarkdown(
                    directory.id,
                    user,
                );

                spinner.stop();
                console.log(chalk.green('\n✓ Markdown regeneration completed successfully!'));
                console.log(chalk.gray('Status:'), chalk.white(result.status));

                console.log(chalk.cyan('\n--- Next Steps ---'));
                console.log(chalk.gray('  • Check your repository for updated files'));
                console.log(chalk.gray('  • Review the generated markdown content'));
                console.log(chalk.gray('  • The changes have been committed automatically'));
            } catch (error) {
                spinner.stop();
                throw error;
            }
        } catch (error) {
            handleCliError(error, 'Failed to regenerate markdown');
            process.exit(1);
        }
    }
}
