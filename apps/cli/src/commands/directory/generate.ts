import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService, CreateItemsGeneratorDto } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';
import { GeneratePromptService } from './generate-prompt.service';
import { handleCliError } from '../../utils/error';
import { GenerateStatusType } from '@ever-works/cli-shared';
import { WEB_URL } from '../../utils/constants';

export const generateCommand = new Command('generate')
    .description('Generate data and create a repository for a directory')
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
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            const directory = selection.directory;
            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\n✓ Selected directory: ${directoryPrompt.formatSelectedDirectory(directory, role, isShared)}`,
                ),
            );

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

            // Check git provider connection dynamically
            const gitProvidersResponse = await apiService.getGitProviders();
            const enabledProviders = gitProvidersResponse.providers.filter((p) => p.enabled);
            let gitConnected = false;

            for (const provider of enabledProviders) {
                try {
                    const connection = await apiService.checkGitProviderConnection(provider.id);
                    if (connection.connected) {
                        gitConnected = true;
                        break;
                    }
                } catch {
                    // Skip providers that fail
                }
            }

            if (!gitConnected) {
                console.log(
                    chalk.yellow('\n⚠ No git provider is connected. Please connect your account.'),
                );
                console.log(
                    chalk.gray('  • Go to ') +
                        chalk.cyan(WEB_URL) +
                        chalk.gray(' to connect your git provider account'),
                );
                return;
            }

            // Collect generation parameters
            console.log(chalk.cyan('\nGeneration Configuration'));

            // Prompt for required fields
            const requiredData = await generatePrompt.promptRequiredFields(
                `${directory.name} Content Generation`,
            );

            // Fetch generator form schema for provider selection and dynamic fields
            const spinner = ora('Loading generator configuration...').start();
            let schema = await apiService.getGeneratorFormSchema(directory.id);
            spinner.succeed('Generator configuration loaded');

            // Provider selection
            const providerResult = await generatePrompt.promptProviderSelection(schema);

            // If a pipeline was selected, re-fetch schema with pipeline-specific fields
            if (providerResult.pipelineId) {
                const pipelineSpinner = ora('Loading pipeline configuration...').start();
                schema = await apiService.getGeneratorFormSchema(
                    directory.id,
                    providerResult.pipelineId,
                );
                pipelineSpinner.succeed('Pipeline configuration loaded');
            }

            // Dynamic plugin fields
            let pluginConfig: Record<string, unknown> = {};
            if (schema.pluginFields && schema.pluginFields.length > 0) {
                pluginConfig = await generatePrompt.promptDynamicFields(
                    schema.pluginFields,
                    schema.pluginGroups,
                    schema.defaultValues,
                );
            }

            const createItemsGeneratorDto: CreateItemsGeneratorDto = {
                name: requiredData.name,
                prompt: requiredData.prompt,
            };

            // Set providers if any were selected
            const hasProviders = Object.values(providerResult.providers).some(Boolean);
            if (hasProviders) {
                createItemsGeneratorDto.providers = providerResult.providers;
            }

            // Set plugin config if any fields were filled
            if (Object.keys(pluginConfig).length > 0) {
                createItemsGeneratorDto.pluginConfig = pluginConfig;
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
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            // Start generation
            const genSpinner = ora('Starting generation process...').start();

            try {
                const response = await apiService.generateContent(
                    directory.id,
                    createItemsGeneratorDto,
                );

                if (response.status === 'error') {
                    genSpinner.fail('\n✗ Generation failed');
                    return;
                } else {
                    genSpinner.succeed('\n✓ Generation process started!');
                }

                // Tell user to use ever-works status to check status
                console.log('');
                console.log(
                    chalk.gray('  • Use ') +
                        chalk.cyan('ever-works directory status') +
                        chalk.gray(' to check the status of your generation'),
                );
            } catch (error) {
                genSpinner.fail('Generation failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);

            process.exit(1);
        }
    });
