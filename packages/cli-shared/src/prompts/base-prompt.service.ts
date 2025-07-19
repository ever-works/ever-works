import inquirer from 'inquirer';
import chalk from 'chalk';

export abstract class BasePromptService {
	/**
	 * Displays a section header
	 */
	protected displaySectionHeader(title: string): void {
		console.log('\n' + chalk.cyan.bold(`=== ${title} ===`));
	}

	/**
	 * Displays an info message
	 */
	protected displayInfo(message: string): void {
		console.log(chalk.blue('ℹ ') + message);
	}

	/**
	 * Displays a success message
	 */
	protected displaySuccess(message: string): void {
		console.log(chalk.green('✓ ') + message);
	}

	/**
	 * Displays a warning message
	 */
	protected displayWarning(message: string): void {
		console.log(chalk.yellow('⚠ ') + message);
	}

	/**
	 * Displays an error message
	 */
	protected displayError(message: string): void {
		console.log(chalk.red('✗ ') + message);
	}

	/**
	 * Prompts for a required text input with custom validation
	 */
	protected async promptRequiredText(
		message: string,
		defaultValue?: string,
		validator?: (input: string) => string | boolean
	): Promise<string> {
		const { value } = await inquirer.prompt([
			{
				type: 'input',
				name: 'value',
				message,
				default: defaultValue,
				validate: (input: string) => {
					if (!input || input.trim().length === 0) {
						return 'This field is required';
					}
					if (validator) {
						return validator(input.trim());
					}
					return true;
				}
			}
		]);
		return value.trim();
	}

	/**
	 * Prompts for an optional text input
	 */
	protected async promptOptionalText(
		message: string,
		defaultValue?: string,
		validator?: (input: string) => string | boolean
	): Promise<string | undefined> {
		const { value } = await inquirer.prompt([
			{
				type: 'input',
				name: 'value',
				message,
				default: defaultValue,
				validate: (input: string) => {
					if (!input || input.trim().length === 0) {
						return true; // Optional field
					}
					if (validator) {
						return validator(input.trim());
					}
					return true;
				}
			}
		]);
		return value && value.trim().length > 0 ? value.trim() : undefined;
	}

	/**
	 * Prompts for a password input
	 */
	protected async promptPassword(message: string, validator?: (input: string) => string | boolean): Promise<string> {
		const { value } = await inquirer.prompt([
			{
				type: 'password',
				name: 'value',
				message,
				mask: '*',
				validate: (input: string) => {
					if (!input || input.trim().length === 0) {
						return 'This field is required';
					}
					if (validator) {
						return validator(input.trim());
					}
					return true;
				}
			}
		]);
		return value.trim();
	}

	/**
	 * Prompts for a single selection from a list
	 */
	protected async promptSelect<T extends string>(
		message: string,
		choices: Array<{ name: string; value: T }>,
		defaultValue?: T
	): Promise<T> {
		const { value } = await inquirer.prompt([
			{
				type: 'list',
				name: 'value',
				message,
				choices,
				default: defaultValue
			}
		]);
		return value;
	}

	/**
	 * Prompts for multiple selections from a list
	 */
	protected async promptMultiSelect<T extends string>(
		message: string,
		choices: Array<{ name: string; value: T; checked?: boolean }>
	): Promise<T[]> {
		const { value } = await inquirer.prompt({
			type: 'checkbox',
			name: 'value',
			message,
			choices
		});
		return value;
	}

	/**
	 * Prompts for a confirmation
	 */
	protected async promptConfirm(message: string, defaultValue: boolean = false): Promise<boolean> {
		const { value } = await inquirer.prompt([
			{
				type: 'confirm',
				name: 'value',
				message,
				default: defaultValue
			}
		]);
		return value;
	}

	/**
	 * Prompts for a number input
	 */
	protected async promptNumber(
		message: string,
		defaultValue?: number,
		validator?: (input: number) => string | boolean
	): Promise<number> {
		const { value } = await inquirer.prompt({
			type: 'input',
			name: 'value',
			message,
			default: defaultValue?.toString(),
			validate: (input: string) => {
				const num = parseFloat(input);
				if (isNaN(num)) {
					return 'Please enter a valid number';
				}
				if (validator) {
					return validator(num);
				}
				return true;
			}
		});
		return parseFloat(value);
	}

	/**
	 * Validates URL format
	 */
	protected validateUrl(url: string): string | boolean {
		try {
			new URL(url);
			return true;
		} catch {
			return 'Please enter a valid URL (e.g., https://example.com)';
		}
	}

	/**
	 * Validates email format
	 */
	protected validateEmail(email: string): string | boolean {
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			return 'Please enter a valid email address';
		}
		return true;
	}

	/**
	 * Validates GitHub username format
	 */
	protected validateGitHubUsername(username: string): string | boolean {
		if (username.length < 1 || username.length > 39) {
			return 'GitHub username must be between 1 and 39 characters';
		}
		const usernameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
		if (!usernameRegex.test(username)) {
			return 'GitHub username can only contain alphanumeric characters and hyphens, and cannot start or end with a hyphen';
		}
		return true;
	}

	/**
	 * Validates API key format (basic validation)
	 */
	protected validateApiKey(apiKey: string): string | boolean {
		if (apiKey.length < 10) {
			return 'API key seems too short (minimum 10 characters)';
		}
		if (apiKey.length > 200) {
			return 'API key seems too long (maximum 200 characters)';
		}
		return true;
	}

	/**
	 * Validates model name format
	 */
	protected validateModelName(modelName: string): string | boolean {
		if (modelName.length < 2) {
			return 'Model name must be at least 2 characters long';
		}
		if (modelName.length > 100) {
			return 'Model name must be less than 100 characters';
		}
		// Allow alphanumeric, hyphens, underscores, dots, and slashes (for provider/model format)
		const modelRegex = /^[a-zA-Z0-9\-_.\/]+$/;
		if (!modelRegex.test(modelName)) {
			return 'Model name can only contain letters, numbers, hyphens, underscores, dots, and slashes (e.g., gpt-4, claude-3-opus, provider/model-name)';
		}
		return true;
	}

	/**
	 * Validates slug format
	 */
	protected validateSlug(slug: string): string | boolean {
		if (slug.length < 2) {
			return 'Slug must be at least 2 characters long';
		}
		if (slug.length > 50) {
			return 'Slug must be less than 50 characters';
		}
		const slugRegex = /^[a-z0-9-]+$/;
		if (!slugRegex.test(slug)) {
			return 'Slug can only contain lowercase letters, numbers, and hyphens';
		}
		if (slug.startsWith('-') || slug.endsWith('-')) {
			return 'Slug cannot start or end with a hyphen';
		}
		if (slug.includes('--')) {
			return 'Slug cannot contain consecutive hyphens';
		}
		return true;
	}

	/**
	 * Generates a slug from a name
	 */
	protected slugifyName(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, '')
			.replace(/\s+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '');
	}
}
