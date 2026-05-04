import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { MarkdownReadmeConfigDto } from '@ever-works/agent/dto';
import { WorkRepository, WorkMemberRepository, UserRepository } from '@ever-works/agent/database';
import { Work, WorkMemberRole } from '@ever-works/agent/entities';
import { validateSlug, BasePromptService } from '@ever-works/cli-shared';

export interface WorkInputData {
    slug: string;
    name: string;
    description: string;
    owner?: string;
    readmeConfig?: MarkdownReadmeConfigDto;
    cancelled?: boolean;
}

export interface SlugConflictResolution {
    action: 'use_suggested' | 'modify' | 'cancel';
    finalSlug?: string;
}

export interface WorkSelection {
    work: Work | null;
    cancelled: boolean;
    role?: WorkMemberRole;
    isShared?: boolean;
}

@Injectable()
export class WorkPromptService extends BasePromptService {
    constructor(
        private readonly userRepository: UserRepository,
        private readonly workMemberRepository: WorkMemberRepository,
    ) {
        super();
    }

    async promptWorkCreation(
        ownerDefault?: string,
        orgs?: { name: string; value: any }[],
    ): Promise<WorkInputData> {
        this.displaySectionHeader('Work Creation');
        this.displayInfo('Please provide the following information to create a new work:');

        // Required fields - start with name first
        const name = await this.promptRequiredText(
            'Work name (display name):',
            undefined,
            this.validateName.bind(this),
        );

        // Generate initial slug from name
        const initialSlug = this.slugifyName(name);

        const description = await this.promptRequiredText(
            'Work description:',
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
                    'Owner (username/organization)?',
                    orgs,
                    ownerDefault,
                );
            } else {
                owner = await this.promptOptionalText(
                    'Owner (username/organization) (leave empty to use default user):',
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
            { name: 'Cancel work creation', value: 'cancel' },
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
     * Prompts user to select a work from available works.
     * Includes both owned works and works shared with the user.
     */
    async promptWorkSelection(workRepository: WorkRepository): Promise<WorkSelection> {
        try {
            // Get local user and all accessible works (owned + shared)
            const user = await this.userRepository.createOrGetLocalUser();

            // Get membership info to determine roles
            const memberships = await this.workMemberRepository.findByUser(user.id);
            const memberWorkIds = memberships.map((m) => m.workId);
            const membershipMap = new Map(memberships.map((m) => [m.workId, m.role]));

            // Get all accessible works
            const works = await workRepository.findAllAccessible({
                userId: user.id,
                memberWorkIds,
            });

            if (works.length === 0) {
                console.log(chalk.yellow('\n⚠ No works found.'));
                console.log(
                    chalk.gray('Create your first work with: ') + chalk.cyan('work create'),
                );
                return { work: null, cancelled: true };
            }

            this.displaySectionHeader('Work Selection');
            this.displayInfo(`Found ${works.length} works. Please select one:`);

            type Choice = { name: string; value: Work | null; short: string };

            const choices: Choice[] = works.map((dir) => {
                const isOwned = dir.userId === user.id;
                const role = isOwned
                    ? WorkMemberRole.OWNER
                    : membershipMap.get(dir.id) || WorkMemberRole.VIEWER;

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

            const { selectedWork } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedWork',
                    message: 'Select a work:',
                    choices,
                    pageSize: 10,
                },
            ]);

            if (!selectedWork) {
                return { work: null, cancelled: true };
            }

            // Determine role for the selected work
            const isOwned = selectedWork.userId === user.id;
            const role = isOwned
                ? WorkMemberRole.OWNER
                : membershipMap.get(selectedWork.id) || WorkMemberRole.VIEWER;

            return {
                work: selectedWork,
                cancelled: false,
                role,
                isShared: !isOwned,
            };
        } catch (error) {
            console.log(chalk.red('\n✗ Failed to load works:'), error.message);
            return { work: null, cancelled: true };
        }
    }

    /**
     * Formats a work selection message showing the role.
     */
    formatSelectedWork(work: Work, role: WorkMemberRole, isShared: boolean): string {
        const roleLabel = this.formatRoleLabel(role, isShared);
        return `${work.name} (${work.slug}) ${roleLabel}`;
    }

    private formatRoleLabel(role: WorkMemberRole, isShared: boolean): string {
        const roleLabels: Record<WorkMemberRole, string> = {
            [WorkMemberRole.OWNER]: 'Owner',
            [WorkMemberRole.MANAGER]: 'Manager',
            [WorkMemberRole.EDITOR]: 'Editor',
            [WorkMemberRole.VIEWER]: 'Viewer',
        };

        const label = roleLabels[role] || role;
        return isShared ? chalk.magenta(`[${label}]`) : chalk.gray(`[${label}]`);
    }
}
