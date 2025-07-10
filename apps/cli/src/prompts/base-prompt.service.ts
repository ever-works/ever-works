import { Injectable, Logger } from '@nestjs/common';
import inquirer from 'inquirer';
import chalk from 'chalk';

@Injectable()
export abstract class BasePromptService {
    protected readonly logger = new Logger(this.constructor.name);

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
     * Prompts for a required text input
     */
    protected async promptRequiredText(
        name: string,
        message: string,
        defaultValue?: string
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
                    return true;
                },
            },
        ]);
        return value.trim();
    }

    /**
     * Prompts for an optional text input
     */
    protected async promptOptionalText(
        name: string,
        message: string,
        defaultValue?: string
    ): Promise<string | undefined> {
        const { value } = await inquirer.prompt([
            {
                type: 'input',
                name: 'value',
                message,
                default: defaultValue,
            },
        ]);
        return value?.trim() || undefined;
    }

    /**
     * Prompts for a password input
     */
    protected async promptPassword(
        name: string,
        message: string,
        required: boolean = true
    ): Promise<string | undefined> {
        const { value } = await inquirer.prompt([
            {
                type: 'password',
                name: 'value',
                message,
                mask: '*',
                validate: required
                    ? (input: string) => {
                          if (!input || input.trim().length === 0) {
                              return 'This field is required';
                          }
                          return true;
                      }
                    : undefined,
            },
        ]);
        return value?.trim() || undefined;
    }

    /**
     * Prompts for a single selection from a list
     */
    protected async promptSelect<T extends string>(
        name: string,
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
                default: defaultValue,
            },
        ]);
        return value;
    }

    /**
     * Prompts for multiple selections from a list
     */
    protected async promptMultiSelect<T extends string>(
        name: string,
        message: string,
        choices: Array<{ name: string; value: T; checked?: boolean }>,
        validate?: (input: T[]) => boolean | string
    ): Promise<T[]> {
        const { value } = await inquirer.prompt([
            {
                type: 'checkbox',
                name: 'value',
                message,
                choices,
                validate,
            },
        ]);
        return value;
    }

    /**
     * Prompts for a confirmation
     */
    protected async promptConfirm(
        name: string,
        message: string,
        defaultValue: boolean = false
    ): Promise<boolean> {
        const { value } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'value',
                message,
                default: defaultValue,
            },
        ]);
        return value;
    }

    /**
     * Prompts for a number input
     */
    protected async promptNumber(
        name: string,
        message: string,
        defaultValue?: number,
        min?: number,
        max?: number
    ): Promise<number> {
        const { value } = await inquirer.prompt([
            {
                type: 'number',
                name: 'value',
                message,
                default: defaultValue,
                validate: (input: number) => {
                    if (isNaN(input)) {
                        return 'Please enter a valid number';
                    }
                    if (min !== undefined && input < min) {
                        return `Value must be at least ${min}`;
                    }
                    if (max !== undefined && input > max) {
                        return `Value must be at most ${max}`;
                    }
                    return true;
                },
            },
        ]);
        return value;
    }
}
