import inquirer from 'inquirer';
import chalk from 'chalk';
import { GIT_USERNAME_REGEX } from '../utils/validation-utils';

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
	 * Prompts for a password input
	 */
	protected async promptPasswordRequired(
		message: string,
		required: boolean = true,
		defaultValue?: string
	): Promise<string> {
		const { value } = await inquirer.prompt([
			{
				type: 'password',
				name: 'value',
				message,
				mask: '*',
				default: defaultValue,
				validate: required
					? (input: string) => {
							if (!input || input.trim().length === 0) {
								return 'This field is required';
							}
							return true;
						}
					: undefined
			}
		]);
		return value?.trim() || '';
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
	 * Validates git username format
	 */
	protected validateGitUsername(username: string): string | boolean {
		if (username.length < 1 || username.length > 39) {
			return 'Username must be between 1 and 39 characters';
		}

		if (!GIT_USERNAME_REGEX.test(username)) {
			return 'Username can only contain alphanumeric characters and hyphens, and cannot start or end with a hyphen';
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

	protected validateApiKeyWithProvider(apiKey: string, providerName: string): string | boolean {
		if (apiKey.length < 5) {
			return `${providerName} API key seems too short. Please check and try again`;
		}
		if (apiKey.includes(' ')) {
			return 'API key should not contain spaces';
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
	 * Prompts for a number input (supports decimals)
	 */
	protected async promptNumberMinMax(
		message: string,
		defaultValue?: number,
		min?: number,
		max?: number
	): Promise<number> {
		const { value } = await inquirer.prompt([
			{
				type: 'input',
				name: 'value',
				message,
				default: defaultValue?.toString(),
				validate: (input: string) => {
					const num = parseFloat(input);
					if (isNaN(num)) {
						return 'Please enter a valid number (decimals allowed, e.g., 0.7)';
					}
					if (min !== undefined && num < min) {
						return `Value must be at least ${min}`;
					}
					if (max !== undefined && num > max) {
						return `Value must be at most ${max}`;
					}
					return true;
				}
			}
		]);
		return parseFloat(value);
	}

	protected async promptFloat(message: string, defaultValue: number, min: number, max: number): Promise<number> {
		const { value } = await inquirer.prompt({
			type: 'input',
			name: 'value',
			message: chalk.yellow(message),
			default: defaultValue.toString(),
			validate: (input: string) => {
				const num = parseFloat(input);
				if (isNaN(num) || num < min || num > max) {
					return `Please enter a number between ${min} and ${max}`;
				}
				return true;
			}
		});
		return parseFloat(value);
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

	protected validateTemperature(temp: number): string | boolean {
		if (temp < 0 || temp > 2) {
			return 'Temperature must be between 0.0 and 2.0 (e.g., 0.7 for balanced, 0.1 for deterministic, 1.5 for creative)';
		}
		return true;
	}

	protected validateMaxTokens(tokens: number): string | boolean {
		if (tokens < 1 || tokens > 200000) {
			return 'Max tokens must be between 1 and 200,000 (e.g., 4096 for standard, 8192 for longer responses)';
		}
		// Ensure it's an integer
		if (!Number.isInteger(tokens)) {
			return 'Max tokens must be a whole number (no decimals)';
		}
		return true;
	}

	protected validateGitName(name: string): string | boolean {
		if (name.length < 2) {
			return 'Git name must be at least 2 characters long';
		}
		if (name.length > 100) {
			return 'Git name must be less than 100 characters';
		}
		// Check for valid characters (letters, spaces, common punctuation)
		const nameRegex = /^[a-zA-Z\s\-'.]+$/;
		if (!nameRegex.test(name)) {
			return 'Git name can only contain letters, spaces, hyphens, apostrophes, and periods';
		}
		return true;
	}
}
