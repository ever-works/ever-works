import chalk from 'chalk';
import inquirer from 'inquirer';
import { getHttpClient } from '../../services/http-client';

export interface DirectoryInputData {
    slug: string;
    name: string;
    description: string;
    owner?: string;
    readme_config?: MarkdownReadmeConfigDto;
}

export interface MarkdownReadmeConfigDto {
    header?: string;
    overwrite_default_header?: boolean;
    footer?: string;
    overwrite_default_footer?: boolean;
}

export interface SlugConflictResolution {
    action: 'use_suggested' | 'modify' | 'cancel';
    finalSlug?: string;
}

export interface DirectorySelection {
    directory: Directory | null;
    cancelled: boolean;
}

export interface Directory {
    id: number;
    name: string;
    slug: string;
    website?: string;
    owner: string;
    companyName?: string;
    organization: boolean;
    description: string;
    readmeConfig?: MarkdownReadmeConfigDto;
}

export class DirectoryPromptService {
    private httpClient = getHttpClient();

    async promptDirectoryCreation(defaultOwner?: string): Promise<DirectoryInputData> {
        console.log(chalk.cyan('📝 Directory Information'));
        console.log(chalk.gray('Please provide the following information for your new directory:\n'));

        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'name',
                message: 'Directory name:',
                validate: (input) => input.trim().length > 0 || 'Directory name is required'
            },
            {
                type: 'input',
                name: 'description',
                message: 'Directory description:',
                validate: (input) => input.trim().length > 0 || 'Directory description is required'
            },
            {
                type: 'input',
                name: 'owner',
                message: 'Owner (GitHub username or organization):',
                default: defaultOwner,
                when: () => !!defaultOwner
            }
        ]);

        // Auto-generate slug from name
        const slug = this.generateSlug(answers.name);

        // Ask for advanced configuration
        const advancedConfig = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'configureReadme',
                message: 'Configure custom README settings?',
                default: false
            }
        ]);

        let readme_config: MarkdownReadmeConfigDto | undefined;

        if (advancedConfig.configureReadme) {
            const readmeAnswers = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'header',
                    message: 'Custom header text (optional):'
                },
                {
                    type: 'confirm',
                    name: 'overwrite_default_header',
                    message: 'Overwrite default header?',
                    default: false,
                    when: (answers) => !!answers.header
                },
                {
                    type: 'input',
                    name: 'footer',
                    message: 'Custom footer text (optional):'
                },
                {
                    type: 'confirm',
                    name: 'overwrite_default_footer',
                    message: 'Overwrite default footer?',
                    default: false,
                    when: (answers) => !!answers.footer
                }
            ]);

            readme_config = {
                header: readmeAnswers.header || undefined,
                overwrite_default_header: readmeAnswers.overwrite_default_header || false,
                footer: readmeAnswers.footer || undefined,
                overwrite_default_footer: readmeAnswers.overwrite_default_footer || false
            };
        }

        return {
            slug,
            name: answers.name,
            description: answers.description,
            owner: answers.owner,
            readme_config
        };
    }

    async promptSlugConflictResolution(originalSlug: string, suggestedSlug: string): Promise<SlugConflictResolution> {
        console.log(chalk.yellow(`\n⚠ Directory slug "${originalSlug}" already exists.`));
        
        const answer = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'How would you like to proceed?',
                choices: [
                    { name: `Use suggested slug: "${suggestedSlug}"`, value: 'use_suggested' },
                    { name: 'Enter a different slug', value: 'modify' },
                    { name: 'Cancel', value: 'cancel' }
                ]
            }
        ]);

        if (answer.action === 'modify') {
            const slugAnswer = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'slug',
                    message: 'Enter new slug:',
                    validate: (input) => {
                        if (!input.trim()) return 'Slug is required';
                        if (!/^[a-z0-9-]+$/.test(input)) return 'Slug can only contain lowercase letters, numbers, and hyphens';
                        return true;
                    }
                }
            ]);
            return { action: 'modify', finalSlug: slugAnswer.slug };
        }

        return { action: answer.action, finalSlug: suggestedSlug };
    }

    async promptDirectorySelection(): Promise<DirectorySelection> {
        try {
            // Note: This will need a list endpoint in the API
            // For now, we'll create a placeholder implementation
            console.log(chalk.yellow('⚠ Directory listing not yet implemented in API.'));
            console.log(chalk.gray('Please enter the directory slug manually:'));
            
            const answer = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'slug',
                    message: 'Directory slug:',
                    validate: (input) => input.trim().length > 0 || 'Directory slug is required'
                }
            ]);

            // Mock directory object for now
            const directory: Directory = {
                id: 1,
                name: answer.slug,
                slug: answer.slug,
                owner: 'unknown',
                organization: false,
                description: 'Directory selected by slug'
            };

            return { directory, cancelled: false };
        } catch (error) {
            console.error(chalk.red('Error selecting directory:'), error.message);
            return { directory: null, cancelled: true };
        }
    }

    private generateSlug(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }

    generateIncrementedSlug(baseSlug: string, increment: number): string {
        return `${baseSlug}-${increment}`;
    }
}
