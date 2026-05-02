import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { WorkPromptService, canEdit } from './work-prompt.service';
import { handleCliError } from '../../utils/error';
import { PluginSettingsPromptService } from '../plugins/plugin-settings-prompt.service';
import { getVisibleProperties, splitSettingsBySecret } from '@ever-works/plugin/api';
import type { WorkPluginResponse, SettingScopeApi } from '@ever-works/plugin/api';

function getActiveCapabilities(plugin: WorkPluginResponse): string[] {
    return plugin.activeCapabilities ?? [];
}

function getDefaultActiveCapability(plugin: WorkPluginResponse): string | undefined {
    const activeCapabilities = getActiveCapabilities(plugin);
    return plugin.capabilities?.find((capability) => activeCapabilities.includes(capability));
}

export const pluginsCommand = new Command('plugins')
    .description('Manage plugins for a work')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nWork Plugins\n'));

            await requireAuth();

            const apiService = getApiService();
            const workPrompt = new WorkPromptService();

            // Select work
            const selection = await workPrompt.promptWorkSelection();
            if (selection.cancelled || !selection.work) {
                console.log(chalk.yellow('\nOperation cancelled.'));
                return;
            }

            const work = selection.work;
            const role = selection.role!;
            const isShared = selection.isShared!;

            console.log(
                chalk.green(
                    `\nSelected work: ${workPrompt.formatSelectedWork(work, role, isShared)}`,
                ),
            );

            if (!canEdit(role)) {
                console.log(chalk.yellow('\n⚠ You do not have permission to perform this action.'));
                console.log(chalk.gray(`  Your role: ${role}. Required: editor or higher.`));
                return;
            }

            const spinner = ora('Loading work plugins...').start();
            const response = await apiService.getWorkPlugins(work.id);
            const plugins = response.plugins;
            spinner.succeed(`Found ${plugins.length} plugins`);

            if (plugins.length === 0) {
                console.log(chalk.yellow('\nNo plugins configured for this work.'));
                return;
            }

            // Show capability providers
            if (
                response.capabilityProviders &&
                Object.keys(response.capabilityProviders).length > 0
            ) {
                console.log(chalk.cyan.bold('\n  Active Providers'));
                console.log(chalk.gray('  ' + '─'.repeat(50)));
                for (const [capability, provider] of Object.entries(response.capabilityProviders)) {
                    console.log(`  ${chalk.white(capability)} → ${chalk.blue(provider)}`);
                }
            }

            await showWorkPluginList(work.id, plugins);
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });

async function showWorkPluginList(
    workId: string,
    plugins: WorkPluginResponse[],
    clear = false,
): Promise<void> {
    if (clear) console.clear();

    const choices: { name: string; value: string }[] = [];

    for (const plugin of plugins) {
        const dirStatus = plugin.workEnabled ? chalk.green('●') : chalk.gray('○');
        const activeCapabilities = getActiveCapabilities(plugin);
        const capability = activeCapabilities.length
            ? chalk.blue(` [${activeCapabilities.join(', ')}]`)
            : '';
        choices.push({
            name: `${dirStatus} ${plugin.name}${capability} ${chalk.gray(`— ${plugin.category}`)}`,
            value: plugin.pluginId,
        });
    }

    choices.push(new inquirer.Separator('') as any);
    choices.push({ name: chalk.gray('← Exit'), value: '__exit__' });

    const { selectedPlugin } = await inquirer.prompt([
        {
            type: 'list',
            name: 'selectedPlugin',
            message: 'Select a plugin to manage:',
            choices,
            pageSize: 20,
        },
    ]);

    if (selectedPlugin === '__exit__') return;

    const plugin = plugins.find((p) => p.pluginId === selectedPlugin)!;
    await showWorkPluginActions(workId, plugin, true);
}

async function showWorkPluginActions(
    workId: string,
    plugin: WorkPluginResponse,
    clear = false,
): Promise<void> {
    if (clear) console.clear();

    const apiService = getApiService();

    // Display plugin info
    console.log(chalk.cyan.bold(`\n  ${plugin.name}`));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(`  ${chalk.gray('ID:')}        ${plugin.pluginId}`);
    console.log(`  ${chalk.gray('Category:')}  ${plugin.category}`);
    console.log(
        `  ${chalk.gray('User:')}      ${plugin.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`,
    );
    console.log(
        `  ${chalk.gray('Work:')} ${plugin.workEnabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`,
    );
    const activeCapabilities = getActiveCapabilities(plugin);
    if (activeCapabilities.length > 0) {
        console.log(`  ${chalk.gray('Capabilities:')} ${activeCapabilities.join(', ')}`);
    }
    console.log('');

    // Build action choices
    const actions: { name: string; value: string }[] = [];

    if (!plugin.systemPlugin) {
        if (plugin.workEnabled) {
            actions.push({ name: 'Disable for work', value: 'disable' });
        } else {
            actions.push({ name: 'Enable for work', value: 'enable' });
        }
    }

    if (plugin.capabilities?.length > 1) {
        actions.push({ name: 'Set active capability', value: 'capability' });
    }

    if (plugin.settingsSchema) {
        const scopes: SettingScopeApi[] = ['global', 'work'];
        const visibleProps = getVisibleProperties(plugin.settingsSchema, scopes);
        if (Object.keys(visibleProps).length > 0) {
            if (plugin.workEnabled) {
                actions.push({ name: 'Configure work settings', value: 'settings' });
            } else {
                actions.push({
                    name: chalk.gray('Configure work settings (enable plugin first)'),
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
            await handleWorkEnable(workId, plugin);
            break;
        case 'disable':
            await handleWorkDisable(workId, plugin);
            break;
        case 'capability':
            await handleSetCapability(workId, plugin);
            break;
        case 'settings':
            await handleWorkSettings(workId, plugin);
            break;
        case 'settings_disabled':
            console.log(
                chalk.yellow(
                    '\nEnable this plugin for the work first to configure its settings.',
                ),
            );
            break;
    }

    // Reload and navigate
    const spinner = ora('Refreshing...').start();
    const response = await apiService.getWorkPlugins(workId);
    spinner.stop();

    if (action === 'back') {
        await showWorkPluginList(workId, response.plugins, true);
    } else {
        const updatedPlugin = response.plugins.find((p) => p.pluginId === plugin.pluginId);
        if (updatedPlugin) {
            await showWorkPluginActions(workId, updatedPlugin, true);
        } else {
            await showWorkPluginList(workId, response.plugins, true);
        }
    }
}

async function handleWorkEnable(
    workId: string,
    plugin: WorkPluginResponse,
): Promise<void> {
    const apiService = getApiService();

    const data: { activeCapability?: string } = {};

    if (plugin.capabilities?.length > 1) {
        const { capability } = await inquirer.prompt([
            {
                type: 'list',
                name: 'capability',
                message: 'Select active capability:',
                choices: plugin.capabilities.map((c) => ({ name: c, value: c })),
            },
        ]);
        data.activeCapability = capability;
    }

    const spinner = ora('Enabling plugin for work...').start();
    try {
        await apiService.enableWorkPlugin(workId, plugin.pluginId, data);
        spinner.succeed(chalk.green(`"${plugin.name}" enabled for work.`));
    } catch (error) {
        spinner.fail('Failed to enable plugin');
        throw error;
    }
}

async function handleWorkDisable(
    workId: string,
    plugin: WorkPluginResponse,
): Promise<void> {
    const apiService = getApiService();

    const { confirm } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirm',
            message: `Disable "${plugin.name}" for this work?`,
            default: false,
        },
    ]);

    if (!confirm) {
        console.log(chalk.gray('Cancelled.'));
        return;
    }

    const spinner = ora('Disabling plugin...').start();
    try {
        await apiService.disableWorkPlugin(workId, plugin.pluginId);
        spinner.succeed(chalk.green(`"${plugin.name}" disabled for work.`));
    } catch (error) {
        spinner.fail('Failed to disable plugin');
        throw error;
    }
}

async function handleSetCapability(
    workId: string,
    plugin: WorkPluginResponse,
): Promise<void> {
    const apiService = getApiService();
    const activeCapabilities = getActiveCapabilities(plugin);
    const defaultCapability = getDefaultActiveCapability(plugin);

    const { capability } = await inquirer.prompt([
        {
            type: 'list',
            name: 'capability',
            message: 'Select active capability:',
            choices: plugin.capabilities.map((c) => ({
                name: activeCapabilities.includes(c) ? `${c} ${chalk.green('(current)')}` : c,
                value: c,
            })),
            default: defaultCapability,
        },
    ]);

    const spinner = ora('Setting capability...').start();
    try {
        await apiService.setWorkPluginCapability(workId, plugin.pluginId, capability);
        spinner.succeed(chalk.green(`Active capability set to "${capability}".`));
    } catch (error) {
        spinner.fail('Failed to set capability');
        throw error;
    }
}

async function handleWorkSettings(
    workId: string,
    plugin: WorkPluginResponse,
): Promise<void> {
    const apiService = getApiService();

    // Fetch user-level plugin for fallback settings
    const spinner = ora('Loading settings...').start();
    const userPlugin = await apiService.getPlugin(plugin.pluginId);
    spinner.stop();

    console.log(chalk.cyan(`\nConfigure work settings for "${plugin.name}":`));
    console.log(chalk.gray('Leave blank to inherit from user-level settings.\n'));

    const scopes: SettingScopeApi[] = ['global', 'work'];
    const { regular, secret } = splitSettingsBySecret(
        plugin.workSettings || {},
        plugin.settingsSchema!,
        scopes,
    );
    const promptService = new PluginSettingsPromptService();
    const result = await promptService.promptSettings({
        pluginId: plugin.pluginId,
        schema: plugin.settingsSchema!,
        currentSettings: regular,
        currentSecretSettings: secret,
        scope: 'work',
        scopes,
        fallbackSettings: userPlugin.settings,
    });

    if (!result) {
        console.log(chalk.yellow('Cancelled.'));
        return;
    }

    const { confirm } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirm',
            message: 'Save work settings?',
            default: true,
        },
    ]);

    if (!confirm) {
        console.log(chalk.gray('Cancelled.'));
        return;
    }

    const saveSpinner = ora('Saving settings...').start();
    try {
        await apiService.updateWorkPluginSettings(workId, plugin.pluginId, {
            settings: Object.keys(result.settings).length > 0 ? result.settings : undefined,
            secretSettings:
                Object.keys(result.secretSettings).length > 0 ? result.secretSettings : undefined,
        });
        saveSpinner.succeed(chalk.green('Work settings saved.'));
    } catch (error) {
        saveSpinner.fail('Failed to save settings');
        throw error;
    }
}
