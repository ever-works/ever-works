import { SubCommand, CommandRunner } from 'nest-commander';
import chalk from 'chalk';
import { WorkRepository, WorkMemberRepository, UserRepository } from '@ever-works/agent/database';
import { WorkMemberRole } from '@ever-works/agent/entities';
import { ConfigCheckService } from './config-check.service';
import { handleCliError } from './error';

@SubCommand({
    name: 'list',
    description: 'List all works',
})
export class ListSubCommand extends CommandRunner {
    constructor(
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
        private readonly userRepository: UserRepository,
        private readonly configCheck: ConfigCheckService,
    ) {
        super();
    }

    async run(): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\nWork List\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            // Get local user and all accessible works (owned + shared)
            const user = await this.userRepository.createOrGetLocalUser();

            // Get membership info to determine roles
            const memberships = await this.workMemberRepository.findByUser(user.id);
            const memberWorkIds = memberships.map((m) => m.workId);
            const membershipMap = new Map(memberships.map((m) => [m.workId, m.role]));

            // Get all accessible works
            const works = await this.workRepository.findAllAccessible({
                userId: user.id,
                memberWorkIds,
            });

            if (works.length === 0) {
                console.log(chalk.yellow('\n⚠ No works found.'));
                console.log(
                    chalk.gray('Create your first work with: ') + chalk.cyan('work create'),
                );
                return;
            }

            // Display works in a table format
            console.log(chalk.cyan('\nWorks:\n'));

            // Table headers - added Role column
            const headers = ['ID', 'Slug', 'Name', 'Role', 'Owner', 'Description'];
            const columnWidths = [4, 18, 22, 9, 12, 38];

            // Print header
            this.printTableRow(headers, columnWidths, true);
            this.printSeparator(columnWidths);

            // Print work rows
            works.forEach((dir) => {
                // Determine user's role
                const role =
                    dir.userId === user.id
                        ? WorkMemberRole.OWNER
                        : membershipMap.get(dir.id) || WorkMemberRole.VIEWER;

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

            const ownedCount = works.filter((d) => d.userId === user.id).length;
            const sharedCount = works.length - ownedCount;

            console.log(chalk.gray(`\nTotal: ${works.length} works`));
            if (sharedCount > 0) {
                console.log(
                    chalk.gray(`  • ${ownedCount} owned, `) +
                        chalk.magenta(`${sharedCount} shared with you`),
                );
            }
            console.log(
                chalk.gray('\nUse ') +
                    chalk.cyan('work create') +
                    chalk.gray(' to create a new work.'),
            );
        } catch (error) {
            handleCliError(error, 'Failed to list works');
            process.exit(1);
        }
    }

    private formatRole(role: WorkMemberRole, isShared: boolean): string {
        const roleLabels: Record<WorkMemberRole, string> = {
            [WorkMemberRole.OWNER]: 'Owner',
            [WorkMemberRole.MANAGER]: 'Manager',
            [WorkMemberRole.EDITOR]: 'Editor',
            [WorkMemberRole.VIEWER]: 'Viewer',
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
            // Use a slightly different style for shared works
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
