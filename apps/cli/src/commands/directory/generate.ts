import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService, type CreateItemsGeneratorDto } from '../../services/api.service';
import { GenerationMethod, WebsiteRepositoryCreationMethod } from '../../services/api.service';
import { DirectoryPromptService, GenerateStatusType, canEdit } from './directory-prompt.service';
import { GeneratePromptService } from './generate-prompt.service';
import { handleCliError } from '../../utils/error';
import { WEB_URL } from '../../utils/constants';
import { buildSelectedProviders, findUnconfiguredProviders } from '@ever-works/plugin';

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

            if (!canEdit(role)) {
                console.log(chalk.yellow('\n⚠ You do not have permission to perform this action.'));
                console.log(chalk.gray(`  Your role: ${role}. Required: editor or higher.`));
                return;
            }

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

            // Fetch config and generator form schema in parallel
            const spinner = ora('Loading generator configuration...').start();
            const [config, schema_] = await Promise.all([
                apiService.getDirectoryConfig(directory.id),
                apiService.getGeneratorFormSchema(directory.id),
            ]);
            let schema = schema_;
            spinner.succeed('Generator configuration loaded');

            const initialPrompt = config?.metadata?.initial_prompt || undefined;
            const lastRequestData = config?.metadata?.last_request_data;
            const isGenerated = !!config?.metadata;

            // Collect generation parameters
            console.log(chalk.cyan('\nGeneration Configuration'));

            // Extract resolvedPipelineId from schema as fallback for pipeline selection
            const resolvedPipelineId = schema.resolvedPipelineId || undefined;

            // Step 1: Pipeline selection using initial schema
            const pipelineResult = await generatePrompt.promptPipelineSelection(
                schema,
                lastRequestData?.providers,
                resolvedPipelineId,
            );

            // Step 2: If pipeline selected, re-fetch schema with pipeline-specific filtering
            // This ensures only relevant provider categories are shown (e.g. claude-code only shows screenshot)
            if (pipelineResult.pipelineId) {
                const pipelineSpinner = ora('Loading pipeline configuration...').start();
                schema = await apiService.getGeneratorFormSchema(
                    directory.id,
                    pipelineResult.pipelineId,
                );
                pipelineSpinner.succeed('Pipeline configuration loaded');
            }

            // Step 3: Individual provider selection using (potentially filtered) schema
            const individualProviders = await generatePrompt.promptIndividualProviders(
                schema,
                lastRequestData?.providers,
            );

            // Step 4: Merge selections
            const providerSelections: Partial<typeof individualProviders & { pipeline?: string }> =
                {
                    ...individualProviders,
                };
            if (pipelineResult.pipelineId) {
                providerSelections.pipeline = pipelineResult.pipelineId;
            }

            // Required fields (name is read-only, prompt pre-filled from last generation)
            const requiredData = await generatePrompt.promptRequiredFields(
                directory.name,
                initialPrompt,
            );

            // Dynamic plugin fields (merge lastRequestData.pluginConfig with schema defaults)
            let pluginConfig: Record<string, unknown> = {};
            if (schema.pluginFields && schema.pluginFields.length > 0) {
                const defaults = { ...schema.defaultValues };
                // Only merge last pluginConfig when pipeline matches (mirrors web GeneratorForm behavior)
                const lastPipelineId = lastRequestData?.providers?.pipeline || null;
                const currentPipelineId = pipelineResult.pipelineId;
                const isSamePipeline =
                    (currentPipelineId || 'default') === (lastPipelineId || 'default');
                if (isSamePipeline && lastRequestData?.pluginConfig) {
                    Object.assign(defaults, lastRequestData.pluginConfig);
                }
                pluginConfig = await generatePrompt.promptDynamicFields(
                    schema.pluginFields,
                    schema.pluginGroups,
                    defaults,
                );
            }

            // Resolve provider defaults from schema
            const providers = buildSelectedProviders(providerSelections, schema);

            // Validate no unconfigured providers
            const unconfigured = findUnconfiguredProviders(providerSelections, schema);
            if (unconfigured.length > 0) {
                console.log(chalk.yellow(`\nUnconfigured providers: ${unconfigured.join(', ')}`));
                console.log(chalk.gray('Configure them in Settings > Plugins before generating.'));
                return;
            }

            // Sanitize plugin config before sending
            if (pluginConfig && Object.keys(pluginConfig).length > 0) {
                pluginConfig = sanitizePluginConfig(pluginConfig);
            }

            // Generation options:
            // - New directories: always CREATE_UPDATE (no gen method prompt, matching web)
            // - Existing directories: prompt for gen method + PR option
            //   (for simple updates without re-configuring providers, use "directory update" instead)
            let genOptions: {
                generation_method: GenerationMethod;
                update_with_pull_request: boolean;
                website_repository_creation_method: WebsiteRepositoryCreationMethod;
            };

            if (isGenerated) {
                genOptions = await generatePrompt.promptGenerationOptions({
                    generation_method: lastRequestData?.generation_method,
                    update_with_pull_request: lastRequestData?.update_with_pull_request,
                    website_repository_creation_method:
                        lastRequestData?.website_repository_creation_method,
                });

                if (genOptions.generation_method === GenerationMethod.RECREATE) {
                    const { confirmRecreate } = await inquirer.prompt([
                        {
                            type: 'confirm',
                            name: 'confirmRecreate',
                            message: chalk.yellow(
                                'Recreate will delete existing items and regenerate from scratch. This cannot be undone. Continue?',
                            ),
                            default: false,
                        },
                    ]);
                    if (!confirmRecreate) {
                        console.log(chalk.yellow('\nOperation cancelled.'));
                        return;
                    }
                }
            } else {
                genOptions = {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    update_with_pull_request: false,
                    website_repository_creation_method:
                        lastRequestData?.website_repository_creation_method ||
                        WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
                };
            }

            // Build full DTO
            const createItemsGeneratorDto: CreateItemsGeneratorDto = {
                name: requiredData.name,
                prompt: requiredData.prompt,
                generation_method: genOptions.generation_method,
                update_with_pull_request: genOptions.update_with_pull_request,
                website_repository_creation_method: genOptions.website_repository_creation_method,
                providers,
                pluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined,
            };

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

/**
 * Sanitize plugin config values before sending to API.
 * Mirrors web's sanitizePluginConfig in apps/web/src/app/actions/dashboard/generator.ts
 */
function sanitizePluginConfig(config: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(config)) {
        if (value === undefined || value === null) {
            continue;
        }

        // String arrays (categories, keywords, tags, etc.)
        if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
            if (key.includes('url')) {
                // URL arrays get trimmed only
                sanitized[key] = (value as string[]).map((v) => v.trim()).filter(Boolean);
            } else {
                // Other string arrays get trimmed and cleaned
                sanitized[key] = (value as string[])
                    .map((v) => v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim())
                    .filter(Boolean);
            }
        } else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}
