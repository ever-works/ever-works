import chalk from 'chalk';
import inquirer from 'inquirer';
import { BasePromptService } from './base-prompt.service';
import { validateSlug } from '../utils/slug-utils';

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

export class DirectoryPromptService extends BasePromptService {
	async promptDirectoryCreation(ownerDefault?: string): Promise<DirectoryInputData> {
		this.displaySectionHeader('Directory Creation');
		this.displayInfo('Please provide the following information to create a new directory:');

		// Required fields - start with name first
		const name = await this.promptRequiredText(
			'Directory name (display name):',
			undefined,
			this.validateName.bind(this)
		);

		// Generate initial slug from name
		const initialSlug = this.slugifyName(name);

		const description = await this.promptRequiredText(
			'Directory description:',
			undefined,
			this.validateDescription.bind(this)
		);

		// Optional fields
		console.log(chalk.cyan('\n--- Optional Fields ---'));

		const wantsOptionalFields = await this.promptConfirm(
			'Do you want to provide optional fields (owner, readme configuration)?',
			false
		);

		let owner: string | undefined;
		let readme_config: MarkdownReadmeConfigDto | undefined;

		if (wantsOptionalFields) {
			owner = await this.promptOptionalText('Owner (leave empty to use default GitHub user):');

			const wantsReadmeConfig = await this.promptConfirm(
				'Do you want to configure custom README header/footer?',
				false
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
			readme_config
		};
	}

	async promptSlugConflictResolution(originalSlug: string, suggestedSlug: string): Promise<SlugConflictResolution> {
		this.displayWarning(`The slug "${originalSlug}" is already taken.`);
		this.displayInfo(`We suggest using "${suggestedSlug}" instead.`);

		const action = await this.promptSelect('What would you like to do?', [
			{ name: `Use suggested slug: "${suggestedSlug}"`, value: 'use_suggested' },
			{ name: 'Modify the slug manually', value: 'modify' },
			{ name: 'Cancel directory creation', value: 'cancel' }
		]);

		if (action === 'modify') {
			const finalSlug = await this.promptRequiredText(
				'Enter your preferred slug:',
				suggestedSlug,
				validateSlug.bind(this)
			);
			return { action, finalSlug };
		}

		return { action, finalSlug: action === 'use_suggested' ? suggestedSlug : undefined };
	}

	/**
	 * Prompts user to select a directory from available directories
	 * This method should be overridden by implementations to provide directory listing
	 */
	async promptDirectorySelection(directories?: Directory[]): Promise<DirectorySelection> {
		if (!directories || directories.length === 0) {
			console.log(chalk.yellow('\n⚠ No directories found.'));
			console.log(chalk.gray('Create your first directory with: ') + chalk.cyan('directory create'));
			return { directory: null, cancelled: true };
		}

		this.displaySectionHeader('Directory Selection');
		this.displayInfo(`Found ${directories.length} directories. Please select one:`);

		type Choice = { name: string; value: Directory | null; short: string };

		const choices: Choice[] = directories.map((dir) => ({
			name: `${chalk.cyan(dir.slug)} - ${dir.name} ${chalk.gray(`(${dir.owner})`)}`,
			value: dir,
			short: dir.slug
		}));

		choices.push({
			name: chalk.gray('Cancel'),
			value: null,
			short: 'cancel'
		});

		const { selectedDirectory } = await inquirer.prompt([
			{
				type: 'list',
				name: 'selectedDirectory',
				message: 'Select a directory:',
				choices,
				pageSize: 10
			}
		]);

		if (!selectedDirectory) {
			return { directory: null, cancelled: true };
		}

		return { directory: selectedDirectory, cancelled: false };
	}

	/**
	 * Prompts for README configuration
	 */
	private async promptReadmeConfig(): Promise<MarkdownReadmeConfigDto> {
		console.log(chalk.cyan('\n--- README Configuration ---'));

		const config: MarkdownReadmeConfigDto = {};

		// Header configuration
		const wantsCustomHeader = await this.promptConfirm('Do you want to add a custom header?', false);

		if (wantsCustomHeader) {
			config.header = await this.promptMultilineText('Enter custom header content:');
			config.overwrite_default_header = await this.promptConfirm(
				'Overwrite the default header completely?',
				false
			);
		}

		// Footer configuration
		const wantsCustomFooter = await this.promptConfirm('Do you want to add a custom footer?', false);

		if (wantsCustomFooter) {
			config.footer = await this.promptMultilineText('Enter custom footer content:');
			config.overwrite_default_footer = await this.promptConfirm(
				'Overwrite the default footer completely?',
				false
			);
		}

		return config;
	}

	/**
	 * Prompts for multiline text input
	 */
	private async promptMultilineText(message: string): Promise<string> {
		console.log(chalk.yellow(message));
		console.log(chalk.gray('(Type your content, then press Enter twice when finished)'));

		const lines: string[] = [];
		let emptyLineCount = 0;

		while (emptyLineCount < 2) {
			const { line } = await inquirer.prompt({
				type: 'input',
				name: 'line',
				message: lines.length === 0 ? '>' : '|'
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

	/**
	 * Validates directory name
	 */
	private validateName(name: string): string | boolean {
		if (name.length < 2) {
			return 'Directory name must be at least 2 characters long';
		}
		if (name.length > 100) {
			return 'Directory name must be less than 100 characters';
		}
		return true;
	}

	/**
	 * Validates directory description
	 */
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
	 * Generates an incremented slug for conflict resolution
	 */
	generateIncrementedSlug(baseSlug: string, increment: number): string {
		return `${baseSlug}-${increment}`;
	}
}
