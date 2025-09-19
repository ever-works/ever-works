import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService, CreateItemsGeneratorDto } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';
import { GeneratePromptService } from './generate-prompt.service';
import { handleCliError } from '../../utils/error';
import { GenerateStatusType, RepoProvider } from '@packages/cli-shared';
import { WEB_URL } from '../../utils/constants';

export const generateCommand = new Command('generate')
    .description('Generate data and create a GitHub repository for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nGenerate Directory Content\n'));

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

            if (directory.generateStatus?.status === GenerateStatusType.GENERATING) {
                console.log(chalk.yellow('\n⚠ Generation already in progress.'));

                if (directory.generateStatus.step) {
                    console.log(
                        chalk.gray('Current step:'),
                        chalk.white(directory.generateStatus.step),
                    );
                }

                console.log(
                    chalk.gray('To check the status, use ') +
                        chalk.cyan('ever-works directory status') +
                        chalk.gray(' command.'),
                );
                return;
            }

            // Check if github is connected
            const githubConnected = await apiService.checkConnection(RepoProvider.GITHUB);
            if (!githubConnected.connected) {
                console.log(
                    chalk.yellow(
                        '\n⚠ GitHub is not connected. Please connect your GitHub account.',
                    ),
                );
                // User should go to the web app to connect their GitHub account
                console.log(
                    chalk.gray('  • Go to ') +
                        chalk.cyan(WEB_URL) +
                        chalk.gray(' to connect your GitHub account'),
                );
                return;
            }

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
                const response = await apiService.generateContent(
                    directory.id,
                    createItemsGeneratorDto,
                );

                if (response.status === 'error') {
                    spinner.fail('\n✗ Generation failed');
                    return;
                } else {
                    spinner.succeed('\n✓ Generation process started!');
                }

                // Tell user to use ever-works status to check status
                console.log(chalk.cyan('\n--- Next Steps ---'));
                console.log(
                    chalk.gray('  • Use ') +
                        chalk.cyan('ever-works directory status') +
                        chalk.gray(' to check the status of your generation'),
                );
            } catch (error) {
                spinner.fail('Generation failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
