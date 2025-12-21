import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import {
    DirectoryRepository,
    DirectoryMemberRepository,
    UserRepository,
} from '@packages/agent/database';
import { DirectoryMemberRole } from '@packages/agent/entities';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';

@SubCommand({
    name: 'list',
    description: 'List all directories',
})
export class ListSubCommand extends CommandRunner {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly directoryMemberRepository: DirectoryMemberRepository,
        private readonly userRepository: UserRepository,
        private readonly configCheck: ConfigCheckService,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nDirectory List\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Get local user and all accessible directories (owned + shared)
            const user = await this.userRepository.createOrGetLocalUser();

            // Get membership info to determine roles
            const memberships = await this.directoryMemberRepository.findByUser(user.id);
            const memberDirectoryIds = memberships.map((m) => m.directoryId);
            const membershipMap = new Map(memberships.map((m) => [m.directoryId, m.role]));

            // Get all accessible directories
            const directories = await this.directoryRepository.findAllAccessible({
                userId: user.id,
                memberDirectoryIds,
            });

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

            // Table headers - added Role column
            const headers = ['ID', 'Slug', 'Name', 'Role', 'Owner', 'Description'];
            const columnWidths = [4, 18, 22, 9, 12, 38];

            // Print header
            this.printTableRow(headers, columnWidths, true);
            this.printSeparator(columnWidths);

            // Print directory rows
            directories.forEach((dir) => {
                // Determine user's role
                const role =
                    dir.userId === user.id
                        ? DirectoryMemberRole.OWNER
                        : membershipMap.get(dir.id) || DirectoryMemberRole.VIEWER;

                const isShared = dir.userId !== user.id;

                const row = [
                    dir.id.toString(),
                    this.truncateText(dir.slug, columnWidths[1] - 2),
                    this.truncateText(dir.name, columnWidths[2] - 2),
                    this.formatRole(role, isShared),
                    this.truncateText(dir.getRepoOwner(), columnWidths[4] - 2),
                    this.truncateText(dir.description, columnWidths[5] - 2),
                ];
                this.printTableRow(row, columnWidths, false, isShared);
            });

            const ownedCount = directories.filter((d) => d.userId === user.id).length;
            const sharedCount = directories.length - ownedCount;

            console.log(chalk.gray(`\nTotal: ${directories.length} directories`));
            if (sharedCount > 0) {
                console.log(
                    chalk.gray(`  • ${ownedCount} owned, `) +
                        chalk.magenta(`${sharedCount} shared with you`),
                );
            }
            console.log(
                chalk.gray('\nUse ') +
                    chalk.cyan('directory create') +
                    chalk.gray(' to create a new directory.'),
            );
        } catch (error) {
            handleCliError(error, 'Failed to list directories');
            process.exit(1);
        }
    }

    private formatRole(role: DirectoryMemberRole, isShared: boolean): string {
        const roleLabels: Record<DirectoryMemberRole, string> = {
            [DirectoryMemberRole.OWNER]: 'Owner',
            [DirectoryMemberRole.MANAGER]: 'Manager',
            [DirectoryMemberRole.EDITOR]: 'Editor',
            [DirectoryMemberRole.VIEWER]: 'Viewer',
        };

        const label = roleLabels[role] || role;
        return isShared ? chalk.magenta(label) : label;
    }

    private printTableRow(
        columns: string[],
        widths: number[],
        isHeader: boolean = false,
        isShared: boolean = false,
    ): void {
        const row = columns
            .map((col, index) => {
                const width = widths[index];
                const paddedCol = col.padEnd(width - 1);
                return paddedCol.substring(0, width - 1);
            })
            .join('│');

        if (isHeader) {
            console.log(chalk.cyan.bold('│' + row + '│'));
        } else if (isShared) {
            // Use a slightly different style for shared directories
            console.log(chalk.gray('│') + row + chalk.gray('│'));
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
