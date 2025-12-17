import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { MarkdownReadmeConfigDto } from '@packages/agent/dto';
import {
    DirectoryRepository,
    DirectoryMemberRepository,
    UserRepository,
} from '@packages/agent/database';
import { Directory, DirectoryMemberRole } from '@packages/agent/entities';
import { validateSlug, BasePromptService } from '@packages/cli-shared';

export interface DirectoryInputData {
    slug: string;
    name: string;
    description: string;
    owner?: string;
    readmeConfig?: MarkdownReadmeConfigDto;
}

export interface SlugConflictResolution {
    action: 'use_suggested' | 'modify' | 'cancel';
    finalSlug?: string;
}

export interface DirectorySelection {
    directory: Directory | null;
    cancelled: boolean;
    role?: DirectoryMemberRole;
    isShared?: boolean;
}

@Injectable()
export class DirectoryPromptService extends BasePromptService {
    constructor(
        private readonly userRepository: UserRepository,
        private readonly directoryMemberRepository: DirectoryMemberRepository,
    ) {
        super();
    }

    async promptDirectoryCreation(
        ownerDefault?: string,
        orgs?: { name: string; value: any }[],
    ): Promise<DirectoryInputData> {
        this.displaySectionHeader('Directory Creation');
        this.displayInfo('Please provide the following information to create a new directory:');

        // Required fields - start with name first
        const name = await this.promptRequiredText(
            'Directory name (display name):',
            undefined,
            this.validateName.bind(this),
        );

        // Generate initial slug from name
        const initialSlug = this.slugifyName(name);

        const description = await this.promptRequiredText(
            'Directory description:',
            undefined,
            this.validateDescription.bind(this),
        );

        // Optional fields
        console.log(chalk.cyan('\n--- Optional Fields ---'));

        const wantsOptionalFields = await this.promptConfirm(
            'Do you want to provide optional fields (owner, readme configuration)?',
            false,
        );

        let owner: string | undefined;
        let readmeConfig: MarkdownReadmeConfigDto | undefined;

        if (wantsOptionalFields) {
            if (orgs) {
                owner = await this.promptSelect(
                    'GitHub Owner (username/organization)?',
                    orgs,
                    ownerDefault,
                );
            } else {
                owner = await this.promptOptionalText(
                    'Owner (username/organization) (leave empty to use default GitHub user):',
                    ownerDefault,
                );
            }

            const wantsReadmeConfig = await this.promptConfirm(
                'Do you want to configure custom README header/footer?',
                false,
            );

            if (wantsReadmeConfig) {
                readmeConfig = await this.promptReadmeConfig();
            }
        }

        return {
            slug: initialSlug, // This will be the initial slug, may be modified later
            name,
            description,
            owner,
            readmeConfig,
        };
    }

    async promptSlugConflictResolution(
        originalSlug: string,
        suggestedSlug: string,
    ): Promise<SlugConflictResolution> {
        this.displayWarning(`The slug "${originalSlug}" is already taken.`);
        this.displayInfo(`We suggest using "${suggestedSlug}" instead.`);

        const action = await this.promptSelect('What would you like to do?', [
            { name: `Use suggested slug: "${suggestedSlug}"`, value: 'use_suggested' },
            { name: 'Modify the slug manually', value: 'modify' },
            { name: 'Cancel directory creation', value: 'cancel' },
        ]);

        if (action === 'modify') {
            const finalSlug = await this.promptRequiredText(
                'Enter your preferred slug:',
                suggestedSlug,
                validateSlug,
            );
            return { action, finalSlug };
        }

        return { action, finalSlug: action === 'use_suggested' ? suggestedSlug : undefined };
    }

    private async promptReadmeConfig(): Promise<MarkdownReadmeConfigDto> {
        this.displaySectionHeader('README Configuration');
        this.displayInfo('Configure custom header and footer for your README files.');

        const config: MarkdownReadmeConfigDto = {};

        const wantsHeader = await this.promptConfirm('Do you want to add a custom header?', false);

        if (wantsHeader) {
            config.header = await this.promptMultilineText(
                'Enter the header markdown content (press Enter twice to finish):',
            );

            config.overwriteDefaultHeader = await this.promptConfirm(
                'Overwrite the default header completely?',
                false,
            );
        }

        const wantsFooter = await this.promptConfirm('Do you want to add a custom footer?', false);

        if (wantsFooter) {
            config.footer = await this.promptMultilineText(
                'Enter the footer markdown content (press Enter twice to finish):',
            );

            config.overwriteDefaultFooter = await this.promptConfirm(
                'Overwrite the default footer completely?',
                false,
            );
        }

        return config;
    }

    private async promptMultilineText(message: string): Promise<string> {
        console.log(chalk.yellow(message));
        console.log(chalk.gray('(Type your content, then press Enter twice when finished)'));

        const lines: string[] = [];
        let emptyLineCount = 0;

        while (emptyLineCount < 2) {
            const { line } = await inquirer.prompt({
                type: 'input',
                name: 'line',
                message: lines.length === 0 ? '>' : '|',
            });

            if (line.trim() === '') {
                emptyLineCount++;
                if (emptyLineCount < 2) {
                    lines.push('');
                }
            } else {
                emptyLineCount = 0;
                lines.push(line);
            }
        }

        return lines.join('\n').trim();
    }

    private validateName(name: string): string | boolean {
        if (name.length < 2) {
            return 'Name must be at least 2 characters long';
        }
        if (name.length > 100) {
            return 'Name must be less than 100 characters';
        }
        return true;
    }

    private validateDescription(description: string): string | boolean {
        if (description.length < 10) {
            return 'Description must be at least 10 characters long';
        }
        if (description.length > 500) {
            return 'Description must be less than 500 characters';
        }
        return true;
    }

    /**
     * Prompts user to select a directory from available directories.
     * Includes both owned directories and directories shared with the user.
     */
    async promptDirectorySelection(
        directoryRepository: DirectoryRepository,
    ): Promise<DirectorySelection> {
        try {
            // Get local user and all accessible directories (owned + shared)
            const user = await this.userRepository.createOrGetLocalUser();

            // Get membership info to determine roles
            const memberships = await this.directoryMemberRepository.findByUser(user.id);
            const memberDirectoryIds = memberships.map((m) => m.directoryId);
            const membershipMap = new Map(memberships.map((m) => [m.directoryId, m.role]));

            // Get all accessible directories
            const directories = await directoryRepository.findAllAccessible({
                userId: user.id,
                memberDirectoryIds,
            });

            if (directories.length === 0) {
                console.log(chalk.yellow('\n⚠ No directories found.'));
                console.log(
                    chalk.gray('Create your first directory with: ') +
                        chalk.cyan('directory create'),
                );
                return { directory: null, cancelled: true };
            }

            this.displaySectionHeader('Directory Selection');
            this.displayInfo(`Found ${directories.length} directories. Please select one:`);

            type Choice = { name: string; value: Directory | null; short: string };

            const choices: Choice[] = directories.map((dir) => {
                const isOwned = dir.userId === user.id;
                const role = isOwned
                    ? DirectoryMemberRole.OWNER
                    : membershipMap.get(dir.id) || DirectoryMemberRole.VIEWER;

                const roleLabel = this.formatRoleLabel(role, !isOwned);

                return {
                    name: `${chalk.cyan(dir.slug)} - ${dir.name} ${roleLabel} ${chalk.gray(`(${dir.getRepoOwner()})`)}`,
                    value: dir,
                    short: dir.slug,
                };
            });

            choices.push({
                name: chalk.gray('Cancel'),
                value: null,
                short: 'cancel',
            });

            const { selectedDirectory } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedDirectory',
                    message: 'Select a directory:',
                    choices,
                    pageSize: 10,
                },
            ]);

            if (!selectedDirectory) {
                return { directory: null, cancelled: true };
            }

            // Determine role for the selected directory
            const isOwned = selectedDirectory.userId === user.id;
            const role = isOwned
                ? DirectoryMemberRole.OWNER
                : membershipMap.get(selectedDirectory.id) || DirectoryMemberRole.VIEWER;

            return {
                directory: selectedDirectory,
                cancelled: false,
                role,
                isShared: !isOwned,
            };
        } catch (error) {
            console.log(chalk.red('\n✗ Failed to load directories:'), error.message);
            return { directory: null, cancelled: true };
        }
    }

    /**
     * Formats a directory selection message showing the role.
     */
    formatSelectedDirectory(
        directory: Directory,
        role: DirectoryMemberRole,
        isShared: boolean,
    ): string {
        const roleLabel = this.formatRoleLabel(role, isShared);
        return `${directory.name} (${directory.slug}) ${roleLabel}`;
    }

    private formatRoleLabel(role: DirectoryMemberRole, isShared: boolean): string {
        const roleLabels: Record<DirectoryMemberRole, string> = {
            [DirectoryMemberRole.OWNER]: 'Owner',
            [DirectoryMemberRole.MANAGER]: 'Manager',
            [DirectoryMemberRole.EDITOR]: 'Editor',
            [DirectoryMemberRole.VIEWER]: 'Viewer',
        };

        const label = roleLabels[role] || role;
        return isShared ? chalk.magenta(`[${label}]`) : chalk.gray(`[${label}]`);
    }
}
