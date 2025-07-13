import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { BasePromptService } from '../config/prompts/base-prompt.service';
import { MarkdownReadmeConfigDto } from '@packages/agent';

export interface DirectoryInputData {
    slug: string;
    name: string;
    description: string;
    owner?: string;
    readme_config?: MarkdownReadmeConfigDto;
}

export interface SlugConflictResolution {
    action: 'use_suggested' | 'modify' | 'cancel';
    finalSlug?: string;
}

@Injectable()
export class DirectoryPromptService extends BasePromptService {
    async promptDirectoryCreation(ownerDefault?: string): Promise<DirectoryInputData> {
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
        let readme_config: MarkdownReadmeConfigDto | undefined;

        if (wantsOptionalFields) {
            owner = await this.promptOptionalText(
                'Owner (leave empty to use default GitHub user):',
                ownerDefault,
            );

            const wantsReadmeConfig = await this.promptConfirm(
                'Do you want to configure custom README header/footer?',
                false,
            );

            if (wantsReadmeConfig) {
                readme_config = await this.promptReadmeConfig();
            }
        }

        return {
            slug: initialSlug, // This will be the initial slug, may be modified later
            name,
            description,
            owner,
            readme_config,
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
                this.validateSlug.bind(this),
            );
            return { action, finalSlug };
        }

        return { action, finalSlug: action === 'use_suggested' ? suggestedSlug : undefined };
    }

    private slugifyName(name: string): string {
        return name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s\-_]/g, '') // Remove special characters except spaces, hyphens, underscores
            .replace(/\s+/g, '-') // Replace spaces with hyphens
            .replace(/[-_]+/g, '-') // Replace multiple consecutive hyphens/underscores with single hyphen
            .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
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

            config.overwrite_default_header = await this.promptConfirm(
                'Overwrite the default header completely?',
                false,
            );
        }

        const wantsFooter = await this.promptConfirm('Do you want to add a custom footer?', false);

        if (wantsFooter) {
            config.footer = await this.promptMultilineText(
                'Enter the footer markdown content (press Enter twice to finish):',
            );

            config.overwrite_default_footer = await this.promptConfirm(
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

    private validateSlug(slug: string): string | boolean {
        // Slug should be URL-friendly: lowercase, alphanumeric, hyphens, underscores
        const slugRegex = /^[a-z0-9][a-z0-9\-_]*[a-z0-9]$|^[a-z0-9]$/;
        if (!slugRegex.test(slug)) {
            return 'Slug must be lowercase, start and end with alphanumeric characters, and can contain hyphens or underscores';
        }
        if (slug.length < 2) {
            return 'Slug must be at least 2 characters long';
        }
        if (slug.length > 50) {
            return 'Slug must be less than 50 characters';
        }
        return true;
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
}
