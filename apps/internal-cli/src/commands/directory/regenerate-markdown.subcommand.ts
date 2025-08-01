import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { DirectoryRepository } from '@packages/agent/database';
import { AgentService } from '@packages/agent/services';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';
import { User } from '@packages/agent/entities';

@SubCommand({
    name: 'regenerate-markdown',
    description: 'Regenerate markdown files for a directory',
})
export class RegenerateMarkdownSubCommand extends CommandRunner {
    private readonly logger = new Logger(RegenerateMarkdownSubCommand.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryPrompt: DirectoryPromptService,
        private readonly configCheck: ConfigCheckService,
        private readonly agentService: AgentService,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\n📄 Regenerate Markdown Files\n'));

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
                const user = await User.sessionMock();

                // Call the agent service method directly
                const result = await this.agentService.regenerateMarkdown(directory.slug, user);

                if (result.status === 'success') {
                    spinner.succeed('Markdown files regenerated successfully');

                    console.log(chalk.green('\n✓ Markdown regeneration completed successfully!'));
                    console.log(chalk.gray('Status:'), chalk.white(result.status));

                    console.log(chalk.cyan('\n--- Next Steps ---'));
                    console.log(chalk.gray('  • Check your repository for updated files'));
                    console.log(chalk.gray('  • Review the generated markdown content'));
                    console.log(chalk.gray('  • The changes have been committed automatically'));
                } else if (result.error_details) {
                    spinner.fail();
                    console.log(chalk.red('\n--- Error Details ---'));
                    console.log(chalk.red(result.error_details));
                }
            } catch (error) {
                spinner.fail('Failed to regenerate markdown files');
                throw error;
            }
        } catch (error) {
            this.logger.error('Failed to regenerate markdown:', error);
            console.log(chalk.red('\n✗ Failed to regenerate markdown:'), error.message);
        }
    }
}
