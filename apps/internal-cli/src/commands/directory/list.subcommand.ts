import { SubCommand, CommandRunner } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import { DirectoryRepository } from '@packages/agent/database';
import { ConfigCheckService } from './config-check.service';

@SubCommand({
    name: 'list',
    description: 'List all directories',
})
export class ListSubCommand extends CommandRunner {
    private readonly logger = new Logger(ListSubCommand.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly configCheck: ConfigCheckService,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\n📋 Directory List\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            const spinner = ora('Loading directories...').start();
            const directories = await this.directoryRepository.findAll();
            spinner.succeed(`Found ${directories.length} directories`);

            if (directories.length === 0) {
                console.log(chalk.yellow('\n⚠ No directories found.'));
                console.log(
                    chalk.gray('Create your first directory with: ') +
                        chalk.cyan('directory create'),
                );
                return;
            }

            // Display directories in a table format
            console.log(chalk.cyan('\nDirectories:\n'));

            // Table headers
            const headers = ['ID', 'Slug', 'Name', 'Owner', 'Org', 'Description'];
            const columnWidths = [4, 20, 25, 15, 4, 40];

            // Print header
            this.printTableRow(headers, columnWidths, true);
            this.printSeparator(columnWidths);

            // Print directory rows
            directories.forEach((dir) => {
                const row = [
                    dir.id.toString(),
                    this.truncateText(dir.slug, columnWidths[1] - 2),
                    this.truncateText(dir.name, columnWidths[2] - 2),
                    this.truncateText(dir.getRepoOwner(), columnWidths[3] - 2),
                    dir.organization ? 'Yes' : 'No',
                    this.truncateText(dir.description, columnWidths[5] - 2),
                ];
                this.printTableRow(row, columnWidths);
            });

            console.log(chalk.gray(`\nTotal: ${directories.length} directories`));
            console.log(
                chalk.gray('\nUse ') +
                    chalk.cyan('directory create') +
                    chalk.gray(' to create a new directory.'),
            );
        } catch (error) {
            this.logger.error('Failed to list directories:', error);
            console.log(chalk.red('\n✗ Failed to list directories:'), error.message);
        }
    }

    private printTableRow(columns: string[], widths: number[], isHeader: boolean = false): void {
        const row = columns
            .map((col, index) => {
                const width = widths[index];
                const paddedCol = col.padEnd(width - 1);
                return paddedCol.substring(0, width - 1);
            })
            .join('│');

        if (isHeader) {
            console.log(chalk.cyan.bold('│' + row + '│'));
        } else {
            console.log(chalk.gray('│' + row + '│'));
        }
    }

    private printSeparator(widths: number[]): void {
        const separator = widths.map((width) => '─'.repeat(width - 1)).join('┼');
        console.log(chalk.cyan('├' + separator + '┤'));
    }

    private truncateText(text: string, maxLength: number): string {
        if (text.length <= maxLength) {
            return text;
        }

        return text.substring(0, maxLength - 3) + '...';
    }
}
