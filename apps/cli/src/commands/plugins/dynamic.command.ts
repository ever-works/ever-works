import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { handleCliError } from '../../utils/error';

/**
 * EW-693 / T36 — CLI subcommands for dynamic plugin distribution.
 *
 * Mirrors the REST surface in apps/api/src/plugins/plugins.controller.ts:
 *
 *   ever-works plugins catalog                # GET /plugins/catalog
 *   ever-works plugins install <id> [--version v --integrity sha512-...]
 *   ever-works plugins uninstall <id>
 *   ever-works plugins install-status <id>
 *
 * The commands rely on the existing CLI auth + apiService wrappers
 * so they pick up the same JWT the rest of the CLI uses. Failures
 * forward through `handleCliError` which surfaces the API's
 * HttpException message (409 / 424 / 502 / 504 from the installer)
 * with a non-zero exit code.
 *
 * Wire-up: register the returned Command on the existing `plugins`
 * top-level command in apps/cli/src/commands/plugins/index.ts via
 * `.addCommand(buildDynamicSubcommands())`.
 */

interface RawApiService {
    get(path: string): Promise<unknown>;
    post(path: string, body?: unknown): Promise<unknown>;
    delete(path: string): Promise<unknown>;
}

function api(): RawApiService {
    const svc = getApiService();
    // The CLI's ApiService is a thin axios wrapper. We type-cast to the
    // raw verb signature so this command file doesn't need a typed
    // surface added to ApiService for every new endpoint — the existing
    // pattern across CLI commands.
    return svc as unknown as RawApiService;
}

function formatInstallRow(row: Record<string, unknown> | null | undefined): string {
    if (!row || typeof row !== 'object') return chalk.gray('(unknown)');
    const state = String(row.installState ?? 'available');
    const source = String(row.source ?? 'bundled');
    const version = row.installedVersion ? String(row.installedVersion) : '';
    const tone =
        state === 'installed'
            ? chalk.green
            : state === 'error'
              ? chalk.red
              : state === 'installing'
                ? chalk.blue
                : chalk.gray;
    const versionTag = version ? chalk.gray(`  ${version}`) : '';
    return `${tone(state.padEnd(12))} ${chalk.gray(source.padEnd(10))}${versionTag}`;
}

function buildCatalogCommand(): Command {
    return new Command('catalog')
        .description('List distributable plugins available from the registry (EW-693)')
        .action(async () => {
            try {
                await requireAuth();
                const spinner = ora('Fetching catalog…').start();
                const response = (await api().get('/plugins/catalog')) as {
                    entries?: Array<Record<string, unknown>>;
                    degraded?: boolean;
                    degradedReason?: string;
                };
                spinner.stop();

                const entries = response?.entries ?? [];
                if (response?.degraded) {
                    console.log(
                        chalk.yellow(
                            `\n! Catalog is degraded: ${response.degradedReason ?? 'unknown reason'}.\n`,
                        ),
                    );
                }
                if (entries.length === 0) {
                    console.log(chalk.gray('\nNo distributable plugins in the catalog.'));
                    console.log(
                        chalk.gray(
                            'Run the platform in dynamic mode (PLUGIN_DISTRIBUTION_MODE=dynamic) ' +
                                'and publish plugins to npm to populate this list.',
                        ),
                    );
                    return;
                }

                console.log(chalk.bold(`\n${entries.length} distributable plugin(s):\n`));
                for (const entry of entries) {
                    const installRow = entry.install as Record<string, unknown> | undefined;
                    console.log(
                        `  ${chalk.cyan(String(entry.pluginId).padEnd(28))} ` +
                            `${formatInstallRow(installRow)}  ${chalk.gray(String(entry.description ?? ''))}`,
                    );
                }
                console.log();
            } catch (err) {
                handleCliError(err);
                process.exit(1);
            }
        });
}

function buildInstallCommand(): Command {
    return new Command('install')
        .description('Install a distributable plugin (EW-693)')
        .argument('<pluginId>', 'Plugin ID (e.g. notion-extractor)')
        .option('--version <semver>', 'Pin a specific version (default: latest)')
        .option('--integrity <sha512>', 'Optional sha512 integrity to enforce (FR-10)')
        .option('--source <source>', 'Registry source: npm | github-packages', 'npm')
        .action(
            async (
                pluginId: string,
                options: { version?: string; integrity?: string; source?: string },
            ) => {
                try {
                    await requireAuth();
                    const spinner = ora(`Installing ${pluginId}…`).start();
                    const body: Record<string, unknown> = {};
                    if (options.version) body.version = options.version;
                    if (options.integrity) body.integrity = options.integrity;
                    if (options.source) body.source = options.source;
                    const result = (await api().post(`/plugins/${pluginId}/install`, body)) as {
                        install?: Record<string, unknown>;
                    };
                    spinner.succeed(`Installed ${pluginId}`);
                    console.log(`  ${formatInstallRow(result?.install)}`);
                } catch (err) {
                    handleCliError(err);
                    process.exit(1);
                }
            },
        );
}

function buildUninstallCommand(): Command {
    return new Command('uninstall')
        .description('Uninstall a distributable plugin (EW-693)')
        .argument('<pluginId>', 'Plugin ID (e.g. notion-extractor)')
        .action(async (pluginId: string) => {
            try {
                await requireAuth();
                const spinner = ora(`Uninstalling ${pluginId}…`).start();
                const result = (await api().delete(`/plugins/${pluginId}/install`)) as Record<
                    string,
                    unknown
                >;
                spinner.succeed(`Uninstalled ${pluginId}`);
                console.log(`  ${formatInstallRow(result)}`);
            } catch (err) {
                handleCliError(err);
                process.exit(1);
            }
        });
}

function buildInstallStatusCommand(): Command {
    return new Command('install-status')
        .description('Show the install-lifecycle row for a plugin (EW-693)')
        .argument('<pluginId>', 'Plugin ID')
        .action(async (pluginId: string) => {
            try {
                await requireAuth();
                const row = (await api().get(`/plugins/${pluginId}/install-status`)) as Record<
                    string,
                    unknown
                >;
                console.log(`${chalk.cyan(pluginId)}  ${formatInstallRow(row)}`);
                if (row.installError) {
                    console.log(chalk.red(`  error: ${row.installError}`));
                }
            } catch (err) {
                handleCliError(err);
                process.exit(1);
            }
        });
}

/**
 * Build the EW-693 dynamic-mode subcommand tree. Mount on the existing
 * `plugins` Commander instance via `.addCommand(buildDynamicSubcommands())`.
 */
export function buildDynamicSubcommands(): Command[] {
    return [
        buildCatalogCommand(),
        buildInstallCommand(),
        buildUninstallCommand(),
        buildInstallStatusCommand(),
    ];
}
