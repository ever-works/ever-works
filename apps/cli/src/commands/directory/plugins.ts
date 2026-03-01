import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { DirectoryPromptService } from './directory-prompt.service';
import { handleCliError } from '../../utils/error';
import { PluginSettingsPromptService } from '../plugins/plugin-settings-prompt.service';
import { getVisibleProperties, splitSettingsBySecret } from '@ever-works/plugin/api';
import type { DirectoryPluginResponse, SettingScopeApi } from '@ever-works/plugin/api';

export const pluginsCommand = new Command('plugins')
    .description('Manage plugins for a directory')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\nDirectory Plugins\n'));

            await requireAuth();

            const apiService = getApiService();
            const directoryPrompt = new DirectoryPromptService();

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
                    `\nSelected directory: ${directoryPrompt.formatSelectedDirectory(directory, role, isShared)}`,
                ),
            );

            const spinner = ora('Loading directory plugins...').start();
            const response = await apiService.getDirectoryPlugins(directory.id);
            const plugins = response.plugins;
            spinner.succeed(`Found ${plugins.length} plugins`);

            if (plugins.length === 0) {
                console.log(chalk.yellow('\nNo plugins configured for this directory.'));
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

            await showDirectoryPluginList(directory.id, plugins);
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });

async function showDirectoryPluginList(
    directoryId: string,
    plugins: DirectoryPluginResponse[],
    clear = false,
): Promise<void> {
    if (clear) console.clear();

    const choices: { name: string; value: string }[] = [];

    for (const plugin of plugins) {
        const dirStatus = plugin.directoryEnabled ? chalk.green('●') : chalk.gray('○');
        const capability = plugin.activeCapability
            ? chalk.blue(` [${plugin.activeCapability}]`)
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
    await showDirectoryPluginActions(directoryId, plugin, true);
}

async function showDirectoryPluginActions(
    directoryId: string,
    plugin: DirectoryPluginResponse,
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
        `  ${chalk.gray('Directory:')} ${plugin.directoryEnabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`,
    );
    if (plugin.activeCapability) {
        console.log(`  ${chalk.gray('Capability:')} ${plugin.activeCapability}`);
    }
    console.log('');

    // Build action choices
    const actions: { name: string; value: string }[] = [];

    if (!plugin.systemPlugin) {
        if (plugin.directoryEnabled) {
            actions.push({ name: 'Disable for directory', value: 'disable' });
        } else {
            actions.push({ name: 'Enable for directory', value: 'enable' });
        }
    }

    if (plugin.capabilities?.length > 1) {
        actions.push({ name: 'Set active capability', value: 'capability' });
    }

    if (plugin.settingsSchema) {
        const scopes: SettingScopeApi[] = ['global', 'directory'];
        const visibleProps = getVisibleProperties(plugin.settingsSchema, scopes);
        if (Object.keys(visibleProps).length > 0) {
            if (plugin.directoryEnabled) {
                actions.push({ name: 'Configure directory settings', value: 'settings' });
            } else {
                actions.push({
                    name: chalk.gray('Configure directory settings (enable plugin first)'),
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
            await handleDirectoryEnable(directoryId, plugin);
            break;
        case 'disable':
            await handleDirectoryDisable(directoryId, plugin);
            break;
        case 'capability':
            await handleSetCapability(directoryId, plugin);
            break;
        case 'settings':
            await handleDirectorySettings(directoryId, plugin);
            break;
        case 'settings_disabled':
            console.log(
                chalk.yellow(
                    '\nEnable this plugin for the directory first to configure its settings.',
                ),
            );
            break;
    }

    // Reload and navigate
    const spinner = ora('Refreshing...').start();
    const response = await apiService.getDirectoryPlugins(directoryId);
    spinner.stop();

    if (action === 'back') {
        await showDirectoryPluginList(directoryId, response.plugins, true);
    } else {
        const updatedPlugin = response.plugins.find((p) => p.pluginId === plugin.pluginId);
        if (updatedPlugin) {
            await showDirectoryPluginActions(directoryId, updatedPlugin, true);
        } else {
            await showDirectoryPluginList(directoryId, response.plugins, true);
        }
    }
}

async function handleDirectoryEnable(
    directoryId: string,
    plugin: DirectoryPluginResponse,
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

    const spinner = ora('Enabling plugin for directory...').start();
    try {
        await apiService.enableDirectoryPlugin(directoryId, plugin.pluginId, data);
        spinner.succeed(chalk.green(`"${plugin.name}" enabled for directory.`));
    } catch (error) {
        spinner.fail('Failed to enable plugin');
        throw error;
    }
}

async function handleDirectoryDisable(
    directoryId: string,
    plugin: DirectoryPluginResponse,
): Promise<void> {
    const apiService = getApiService();

    const { confirm } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirm',
            message: `Disable "${plugin.name}" for this directory?`,
            default: false,
        },
    ]);

    if (!confirm) {
        console.log(chalk.gray('Cancelled.'));
        return;
    }

    const spinner = ora('Disabling plugin...').start();
    try {
        await apiService.disableDirectoryPlugin(directoryId, plugin.pluginId);
        spinner.succeed(chalk.green(`"${plugin.name}" disabled for directory.`));
    } catch (error) {
        spinner.fail('Failed to disable plugin');
        throw error;
    }
}

async function handleSetCapability(
    directoryId: string,
    plugin: DirectoryPluginResponse,
): Promise<void> {
    const apiService = getApiService();

    const { capability } = await inquirer.prompt([
        {
            type: 'list',
            name: 'capability',
            message: 'Select active capability:',
            choices: plugin.capabilities.map((c) => ({
                name: c === plugin.activeCapability ? `${c} ${chalk.green('(current)')}` : c,
                value: c,
            })),
            default: plugin.activeCapability,
        },
    ]);

    const spinner = ora('Setting capability...').start();
    try {
        await apiService.setDirectoryPluginCapability(directoryId, plugin.pluginId, capability);
        spinner.succeed(chalk.green(`Active capability set to "${capability}".`));
    } catch (error) {
        spinner.fail('Failed to set capability');
        throw error;
    }
}

async function handleDirectorySettings(
    directoryId: string,
    plugin: DirectoryPluginResponse,
): Promise<void> {
    const apiService = getApiService();

    // Fetch user-level plugin for fallback settings
    const spinner = ora('Loading settings...').start();
    const userPlugin = await apiService.getPlugin(plugin.pluginId);
    spinner.stop();

    console.log(chalk.cyan(`\nConfigure directory settings for "${plugin.name}":`));
    console.log(chalk.gray('Leave blank to inherit from user-level settings.\n'));

    const scopes: SettingScopeApi[] = ['global', 'directory'];
    const { regular, secret } = splitSettingsBySecret(
        plugin.directorySettings || {},
        plugin.settingsSchema!,
        scopes,
    );
    const promptService = new PluginSettingsPromptService();
    const result = await promptService.promptSettings({
        pluginId: plugin.pluginId,
        schema: plugin.settingsSchema!,
        currentSettings: regular,
        currentSecretSettings: secret,
        scope: 'directory',
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
            message: 'Save directory settings?',
            default: true,
        },
    ]);

    if (!confirm) {
        console.log(chalk.gray('Cancelled.'));
        return;
    }

    const saveSpinner = ora('Saving settings...').start();
    try {
        await apiService.updateDirectoryPluginSettings(directoryId, plugin.pluginId, {
            settings: Object.keys(result.settings).length > 0 ? result.settings : undefined,
            secretSettings:
                Object.keys(result.secretSettings).length > 0 ? result.secretSettings : undefined,
        });
        saveSpinner.succeed(chalk.green('Directory settings saved.'));
    } catch (error) {
        saveSpinner.fail('Failed to save settings');
        throw error;
    }
}
