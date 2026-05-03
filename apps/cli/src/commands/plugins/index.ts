import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { handleCliError } from '../../utils/error';
import { PluginSettingsPromptService } from './plugin-settings-prompt.service';
import {
    getVisibleProperties,
    getRequiredFields,
    validateRequiredSettings,
    splitSettingsBySecret,
} from '@ever-works/plugin/api';
import type { UserPluginResponse, SettingScopeApi } from '@ever-works/plugin/api';

export const pluginsCommand = new Command('plugins')
    .description('Manage plugins')
    .option('-c, --category <category>', 'Filter by category')
    .action(async (options) => {
        try {
            console.log(chalk.cyan.bold('\nManage Plugins\n'));

            await requireAuth();

            const apiService = getApiService();
            const spinner = ora('Loading plugins...').start();

            const response = await apiService.getPlugins(
                options.category ? { category: options.category } : undefined,
            );
            const plugins = response.plugins;
            spinner.succeed(`Found ${plugins.length} plugins`);

            if (plugins.length === 0) {
                console.log(chalk.yellow('\nNo plugins found.'));
                return;
            }

            await showPluginList(plugins);
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });

type PluginChoice = { name: string; value: string; short: string };

async function showPluginList(plugins: UserPluginResponse[], clear = false): Promise<void> {
    if (clear) console.clear();

    const grouped = groupByCategory(plugins);
    const groupedChoices = buildGroupedChoices(grouped);
    const flatChoices = buildFlatChoices(grouped);

    const { selectedPlugin } = await inquirer.prompt([
        {
            type: 'search',
            name: 'selectedPlugin',
            message: 'Search plugins:',
            source: (term: string | undefined) => {
                if (!term) return groupedChoices;
                const lower = term.toLowerCase();
                return flatChoices.filter(
                    (c) =>
                        c.value === '__exit__' ||
                        c.name.toLowerCase().includes(lower) ||
                        c.value.toLowerCase().includes(lower),
                );
            },
            pageSize: 20,
        } as any,
    ]);

    if (selectedPlugin === '__exit__') return;

    const plugin = plugins.find((p) => p.pluginId === selectedPlugin)!;
    await showPluginActions(plugin, true);
}

function formatPluginChoice(plugin: UserPluginResponse, categoryLabel?: string): PluginChoice {
    const status = plugin.enabled ? chalk.green('●') : chalk.gray('○');
    const category = categoryLabel ? ` ${chalk.gray(`[${categoryLabel}]`)}` : '';
    return {
        name: `${status} ${plugin.name}${category} ${chalk.gray(`— ${plugin.description || plugin.pluginId}`)}`,
        value: plugin.pluginId,
        short: plugin.name,
    };
}

function buildGroupedChoices(
    grouped: Record<string, UserPluginResponse[]>,
): (PluginChoice | InstanceType<typeof inquirer.Separator>)[] {
    const choices: (PluginChoice | InstanceType<typeof inquirer.Separator>)[] = [];

    for (const [category, categoryPlugins] of Object.entries(grouped)) {
        choices.push(new inquirer.Separator(chalk.cyan.bold(`  ${formatCategory(category)}`)));
        for (const plugin of categoryPlugins) {
            choices.push(formatPluginChoice(plugin));
        }
    }

    choices.push(new inquirer.Separator(''));
    choices.push({ name: chalk.gray('← Exit'), value: '__exit__', short: 'Exit' });
    return choices;
}

function buildFlatChoices(grouped: Record<string, UserPluginResponse[]>): PluginChoice[] {
    const choices: PluginChoice[] = [];
    for (const [category, categoryPlugins] of Object.entries(grouped)) {
        const label = formatCategory(category);
        for (const plugin of categoryPlugins) {
            choices.push(formatPluginChoice(plugin, label));
        }
    }
    choices.push({ name: chalk.gray('← Exit'), value: '__exit__', short: 'Exit' });
    return choices;
}

async function showPluginActions(plugin: UserPluginResponse, clear = false): Promise<void> {
    if (clear) console.clear();

    const apiService = getApiService();

    // Display plugin info
    console.log(chalk.cyan.bold(`\n  ${plugin.name}`));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(`  ${chalk.gray('ID:')}       ${plugin.pluginId}`);
    console.log(`  ${chalk.gray('Version:')}  ${plugin.version}`);
    console.log(`  ${chalk.gray('Category:')} ${plugin.category}`);
    const statusLabel = plugin.systemPlugin
        ? chalk.blue('System')
        : plugin.enabled
          ? chalk.green('Enabled')
          : chalk.gray('Disabled');
    console.log(`  ${chalk.gray('Status:')}   ${statusLabel}`);
    if (plugin.description) {
        console.log(`  ${chalk.gray('About:')}    ${plugin.description}`);
    }
    if (plugin.capabilities?.length) {
        console.log(`  ${chalk.gray('Provides:')} ${plugin.capabilities.join(', ')}`);
    }
    if (plugin.settingsSchema?.properties) {
        const fieldCount = Object.keys(plugin.settingsSchema.properties).length;
        const requiredCount = plugin.settingsSchema.required?.length || 0;
        console.log(
            `  ${chalk.gray('Settings:')} ${fieldCount} fields (${requiredCount} required)`,
        );
    }
    console.log('');

    // Build action choices based on current state
    const actions: { name: string; value: string }[] = [];

    if (!plugin.systemPlugin) {
        if (plugin.enabled) {
            actions.push({ name: 'Disable', value: 'disable' });
        } else {
            actions.push({ name: 'Enable', value: 'enable' });
        }
    }

    if (plugin.settingsSchema) {
        const scopes: SettingScopeApi[] = ['global', 'user'];
        const visibleProps = getVisibleProperties(plugin.settingsSchema, scopes);
        if (Object.keys(visibleProps).length > 0) {
            if (plugin.enabled) {
                actions.push({ name: 'Configure settings', value: 'settings' });
            } else {
                actions.push({
                    name: chalk.gray('Configure settings (enable plugin first)'),
                    value: 'settings_disabled',
                });
            }
        }
    }

    actions.push({ name: chalk.gray('← Back'), value: 'back' });

    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: actions,
        },
    ]);

    switch (action) {
        case 'enable':
            await handleEnable(plugin);
            break;
        case 'disable':
            await handleDisable(plugin);
            break;
        case 'settings':
            await handleSettings(plugin);
            break;
        case 'settings_disabled':
            console.log(chalk.yellow('\nEnable this plugin first to configure its settings.'));
            break;
    }

    // Reload and navigate
    const spinner = ora('Refreshing...').start();
    const response = await apiService.getPlugins();
    spinner.stop();

    if (action === 'back') {
        await showPluginList(response.plugins, true);
    } else {
        const updatedPlugin = response.plugins.find((p) => p.pluginId === plugin.pluginId);
        if (updatedPlugin) {
            await showPluginActions(updatedPlugin, true);
        } else {
            await showPluginList(response.plugins, true);
        }
    }
}

async function handleEnable(plugin: UserPluginResponse): Promise<void> {
    const apiService = getApiService();

    let enableData: {
        settings?: Record<string, unknown>;
        secretSettings?: Record<string, unknown>;
        autoEnableForWorks?: boolean;
    } = {};

    // Check if plugin has required settings that need configuration
    if (plugin.settingsSchema) {
        const scopes: SettingScopeApi[] = ['global', 'user'];
        const requiredFields = getRequiredFields(plugin.settingsSchema, scopes);
        const visibleProps = getVisibleProperties(plugin.settingsSchema, scopes);

        if (requiredFields.length > 0 && Object.keys(visibleProps).length > 0) {
            // Check if existing settings already satisfy requirements
            const { regular, secret } = splitSettingsBySecret(
                plugin.settings || {},
                plugin.settingsSchema,
                scopes,
            );
            const missing = validateRequiredSettings(
                regular,
                secret,
                plugin.settingsSchema,
                scopes,
                'user',
            );

            if (missing.length > 0) {
                console.log(chalk.cyan('\nThis plugin requires configuration before enabling:'));
                const promptService = new PluginSettingsPromptService();
                const result = await promptService.promptSettings({
                    pluginId: plugin.pluginId,
                    schema: plugin.settingsSchema,
                    currentSettings: regular,
                    currentSecretSettings: secret,
                    scope: 'user',
                    scopes,
                });

                if (!result) {
                    console.log(chalk.yellow('Cancelled.'));
                    return;
                }

                enableData = {
                    settings: Object.keys(result.settings).length > 0 ? result.settings : undefined,
                    secretSettings:
                        Object.keys(result.secretSettings).length > 0
                            ? result.secretSettings
                            : undefined,
                };
            }
        }
    }

    const { autoEnable } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'autoEnable',
            message: 'Auto-enable for all works?',
            default: false,
        },
    ]);
    if (autoEnable) {
        enableData.autoEnableForWorks = true;
    }

    const spinner = ora('Enabling plugin...').start();
    try {
        await apiService.enablePlugin(plugin.pluginId, enableData);
        spinner.succeed(chalk.green(`"${plugin.name}" enabled.`));
    } catch (error) {
        spinner.fail('Failed to enable plugin');
        throw error;
    }
}

async function handleDisable(plugin: UserPluginResponse): Promise<void> {
    const apiService = getApiService();

    const { confirm } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirm',
            message: `Disable "${plugin.name}"?`,
            default: false,
        },
    ]);

    if (!confirm) {
        console.log(chalk.gray('Cancelled.'));
        return;
    }

    const spinner = ora('Disabling plugin...').start();
    try {
        await apiService.disablePlugin(plugin.pluginId);
        spinner.succeed(chalk.green(`"${plugin.name}" disabled.`));
    } catch (error) {
        spinner.fail('Failed to disable plugin');
        throw error;
    }
}

async function handleSettings(plugin: UserPluginResponse): Promise<void> {
    const apiService = getApiService();

    // Fetch full plugin details to ensure we have settings
    const loadSpinner = ora('Loading settings...').start();
    const fullPlugin = await apiService.getPlugin(plugin.pluginId);
    loadSpinner.stop();

    console.log(chalk.cyan(`\nConfigure settings for "${plugin.name}":\n`));
    const scopes: SettingScopeApi[] = ['global', 'user'];
    const { regular, secret } = splitSettingsBySecret(
        fullPlugin.settings || {},
        fullPlugin.settingsSchema || plugin.settingsSchema!,
        scopes,
    );
    const promptService = new PluginSettingsPromptService();
    const result = await promptService.promptSettings({
        pluginId: plugin.pluginId,
        schema: plugin.settingsSchema!,
        currentSettings: regular,
        currentSecretSettings: secret,
        scope: 'user',
        scopes,
    });

    if (!result) {
        console.log(chalk.yellow('Cancelled.'));
        return;
    }

    const { confirm } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirm',
            message: 'Save settings?',
            default: true,
        },
    ]);

    if (!confirm) {
        console.log(chalk.gray('Cancelled.'));
        return;
    }

    const spinner = ora('Saving settings...').start();
    try {
        await apiService.updatePluginSettings(plugin.pluginId, {
            settings: Object.keys(result.settings).length > 0 ? result.settings : undefined,
            secretSettings:
                Object.keys(result.secretSettings).length > 0 ? result.secretSettings : undefined,
        });
        spinner.succeed(chalk.green('Settings saved.'));
    } catch (error) {
        spinner.fail('Failed to save settings');
        throw error;
    }
}

function groupByCategory(plugins: UserPluginResponse[]): Record<string, UserPluginResponse[]> {
    const groups: Record<string, UserPluginResponse[]> = {};
    for (const plugin of plugins) {
        const cat = plugin.category || 'other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(plugin);
    }
    return groups;
}

function formatCategory(category: string): string {
    return category
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}
