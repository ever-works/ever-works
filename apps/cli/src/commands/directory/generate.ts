import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService, CreateItemsGeneratorDto } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';
import { GeneratePromptService } from './generate-prompt.service';

export const generateCommand = new Command('generate')
    .description('Generate data and create a GitHub repository for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n🚀 Generate Directory Content\n'));

            // Ensure user is authenticated
            await requireAuth();

            const apiService = getApiService();
            const directoryPrompt = new DirectoryPromptService();
            const generatePrompt = new GeneratePromptService();

            // Select directory
            const selection = await directoryPrompt.promptDirectorySelection();
            if (selection.cancelled || !selection.directory) {
                console.log(chalk.yellow('\n⚠ Operation cancelled.'));
                return;
            }

            const directory = selection.directory;
            console.log(chalk.green(`\n✓ Selected directory: ${directory.slug}`));

            // Collect generation parameters
            console.log(chalk.cyan('\n📝 Generation Configuration'));

            // Prompt for required fields
            const requiredData = await generatePrompt.promptRequiredFields(
                `${directory.name} Content Generation`,
            );

            // Ask for advanced configuration
            const advancedConfig = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'configureAdvanced',
                    message: 'Configure advanced options?',
                    default: false,
                },
            ]);

            let createItemsGeneratorDto: CreateItemsGeneratorDto = {
                slug: directory.slug,
                name: requiredData.name,
                prompt: requiredData.prompt,
            };

            if (advancedConfig.configureAdvanced) {
                // Get advanced options from the prompt service
                const advancedOptions = await generatePrompt.promptAdvancedOptions();

                // Merge advanced options
                Object.assign(createItemsGeneratorDto, advancedOptions);

                // Company information
                const companyConfig = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'addCompany',
                        message: 'Add company information?',
                        default: false,
                    },
                ]);

                if (companyConfig.addCompany) {
                    createItemsGeneratorDto.company = await generatePrompt.promptCompanyInfo();
                }

                // Ask for configuration settings
                const configConfig = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'configureAdvancedSettings',
                        message: 'Configure advanced generation settings?',
                        default: false,
                    },
                ]);

                if (configConfig.configureAdvancedSettings) {
                    createItemsGeneratorDto.config = await generatePrompt.promptConfigOptions();
                }
            }

            // Show summary and confirm
            generatePrompt.displayGenerationSummary(createItemsGeneratorDto);

            const confirmed = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with generation?',
                    default: true,
                },
            ]);

            if (!confirmed.proceed) {
                console.log(chalk.yellow('\n⚠ Generation cancelled.'));
                return;
            }

            // Start generation
            const spinner = ora('Starting generation process...').start();

            try {
                const response = await apiService.generateContent(createItemsGeneratorDto);

                spinner.succeed('Generation started successfully');

                console.log(chalk.green('\n✓ Generation process started!'));
                console.log(chalk.gray('Status:'), chalk.white(response.status));
                if (response.message) {
                    console.log(chalk.gray('Message:'), chalk.white(response.message));
                }

                console.log(chalk.cyan('\nNext Steps:'));
                console.log(chalk.gray('  • Monitor the generation progress in your logs'));
                console.log(chalk.gray('  • Check your GitHub repositories for updates'));
                console.log(
                    chalk.gray('  • Use other directory commands once generation is complete'),
                );
            } catch (error) {
                spinner.fail('Generation failed');
                throw error;
            }
        } catch (error) {
            console.error(
                chalk.red('\n✗ Failed to start generation:'),
                error.response?.data?.message || error.message,
            );

            if (error.response?.status === 401) {
                console.log(chalk.yellow('\n⚠ Authentication failed. Please login again.'));
                console.log(chalk.gray('Run: ever-works auth login'));
            } else if (error.response?.status === 404) {
                console.log(
                    chalk.yellow('\n⚠ Directory not found. Please check the slug and try again.'),
                );
            }

            process.exit(1);
        }
    });
