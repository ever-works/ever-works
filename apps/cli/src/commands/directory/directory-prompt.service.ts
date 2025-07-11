import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { BasePromptService } from '../config/prompts/base-prompt.service';
import { CreateDirectoryDto, MarkdownReadmeConfigDto } from '@packages/agent';

export interface DirectoryInputData {
    slug: string;
    name: string;
    description: string;
    owner?: string;
    readme_config?: MarkdownReadmeConfigDto;
}

@Injectable()
export class DirectoryPromptService extends BasePromptService {
    async promptDirectoryCreation(): Promise<DirectoryInputData> {
        this.displaySectionHeader('Directory Creation');
        this.displayInfo('Please provide the following information to create a new directory:');

        // Required fields
        const slug = await this.promptRequiredText(
            'Directory slug (URL-friendly identifier):',
            undefined,
            this.validateSlug.bind(this),
        );

        const name = await this.promptRequiredText(
            'Directory name (display name):',
            undefined,
            this.validateName.bind(this),
        );

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
            slug,
            name,
            description,
            owner,
            readme_config,
        };
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
