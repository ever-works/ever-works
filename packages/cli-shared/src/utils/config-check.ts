import chalk from 'chalk';

export interface ConfigValidationResult {
	isValid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Base configuration checker interface
 */
export interface ConfigChecker {
	checkConfiguration(): Promise<boolean>;
	requireConfiguration(): Promise<void>;
}

/**
 * Displays configuration error message and setup instructions
 */
export function displayConfigurationError(message: string, errors?: string[]): void {
	console.log(chalk.red('\n✗ Configuration Error:'), message);

	if (errors && errors.length > 0) {
		console.log(chalk.red('\nErrors:'));
		errors.forEach((error) => console.log(chalk.red(`  • ${error}`)));
	}

	console.log(chalk.yellow('\n⚠ Please complete the setup configuration first.'));
	console.log(
		chalk.gray('Run ') + chalk.cyan('ever-works config setup') + chalk.gray(' to configure your settings.')
	);
}

/**
 * Displays configuration warnings
 */
export function displayConfigurationWarnings(warnings: string[]): void {
	if (warnings.length > 0) {
		console.log(chalk.yellow('\n⚠ Configuration Warnings:'));
		warnings.forEach((warning) => console.log(chalk.yellow(`  • ${warning}`)));
	}
}

/**
 * Masks sensitive values for display
 */
export function maskSecret(secret: string): string {
	const MIN_SECRET_LENGTH = 8;
	if (!secret || secret.length < MIN_SECRET_LENGTH) {
		return '****';
	}

	return secret.substring(0, 4) + '*'.repeat(secret.length - MIN_SECRET_LENGTH) + secret.substring(secret.length - 4);
}
