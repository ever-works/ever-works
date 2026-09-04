import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getApiService } from '../../services/api.service';
import { handleCliError } from '../../utils/error';

/**
 * CLI over the Agent Plugins package registry.
 *
 *   ever-works plugins agent-plugins list       # GET /api/agent-plugins
 *   ever-works plugins agent-plugins findings   # GET /api/agent-plugins/findings
 *   ever-works plugins agent-plugins catalog    # GET /api/agent-plugins/catalog
 *
 * Mounted under the existing `plugins` command rather than as a new top-level
 * one, because these ARE plugins from a user's point of view — just packages
 * in the open cross-vendor format rather than native Ever Works code plugins.
 * The nesting keeps that distinction visible without inventing a second
 * vocabulary at the top level.
 *
 * Every command prints the disabled state explicitly. "The flag is off" and
 * "the flag is on and you have no packages" look identical in a bare list,
 * and an operator who has just switched it on needs to tell them apart.
 */

interface RawApiService {
    get(path: string): Promise<unknown>;
}

function api(): RawApiService {
    // The CLI's ApiService is a thin axios wrapper; casting to the raw verb
    // signature is the established pattern here, so a new endpoint does not
    // require a typed method on ApiService.
    return getApiService() as unknown as RawApiService;
}

interface PackageRow {
    name?: string;
    version?: string;
    specVersion?: string;
    dirName?: string;
    path?: string;
    skills?: string[];
    mcpServers?: string[];
    summary?: { errorCount?: number; warningCount?: number };
}

interface ListResponse {
    enabled?: boolean;
    roots?: string[];
    packages?: PackageRow[];
    rejected?: Array<{ dirName?: string; path?: string; summary?: { fatalCount?: number } }>;
    shadowed?: Array<{ dirName?: string; name?: string }>;
}

/** Prints the "feature is off" explanation, and reports whether it did. */
function reportedDisabled(enabled: boolean | undefined): boolean {
    if (enabled !== false) {
        return false;
    }
    console.log(chalk.yellow('\nAgent Plugins support is disabled on this deployment.'));
    console.log(
        chalk.gray('Set FEATURE_AGENT_PLUGINS=true, and AGENT_PLUGINS_DIR if packages live'),
    );
    console.log(chalk.gray('somewhere other than /app/agent-plugins.'));
    return true;
}

function buildListCommand(): Command {
    return new Command('list')
        .description('List installed Agent Plugins packages')
        .option('-s, --search <text>', 'Filter by package name or contributed skill')
        .action(async (options: { search?: string }) => {
            try {
                await requireAuth();
                const spinner = ora('Reading package directories…').start();
                const query = options.search ? `?search=${encodeURIComponent(options.search)}` : '';
                const response = (await api().get(`/agent-plugins${query}`)) as ListResponse;
                spinner.stop();

                if (reportedDisabled(response.enabled)) {
                    return;
                }

                const packages = response.packages ?? [];
                const rejected = response.rejected ?? [];

                console.log(
                    chalk.cyan.bold(`\nAgent Plugins packages (${packages.length} installed)\n`),
                );
                if (response.roots?.length) {
                    console.log(chalk.gray(`  Scanning: ${response.roots.join(', ')}\n`));
                }

                if (packages.length === 0 && rejected.length === 0) {
                    console.log(chalk.gray('  No packages found.'));
                    return;
                }

                for (const pkg of packages) {
                    const version = pkg.version ? chalk.gray(` ${pkg.version}`) : '';
                    const spec = pkg.specVersion ? chalk.gray(` (spec ${pkg.specVersion})`) : '';
                    console.log(
                        `  ${chalk.green('●')} ${chalk.bold(pkg.name ?? pkg.dirName)}${version}${spec}`,
                    );
                    const skills = pkg.skills ?? [];
                    const servers = pkg.mcpServers ?? [];
                    if (skills.length) {
                        console.log(chalk.gray(`      skills: ${skills.join(', ')}`));
                    }
                    if (servers.length) {
                        console.log(chalk.gray(`      mcp:    ${servers.join(', ')}`));
                    }
                    const errors = pkg.summary?.errorCount ?? 0;
                    const warnings = pkg.summary?.warningCount ?? 0;
                    if (errors || warnings) {
                        console.log(
                            chalk.yellow(
                                `      ${errors} error(s), ${warnings} warning(s) — run "findings" for detail`,
                            ),
                        );
                    }
                }

                // Rejected packages are printed too. Somebody put them in that
                // directory on purpose, so their absence needs an explanation
                // rather than silence.
                for (const pkg of rejected) {
                    console.log(
                        `  ${chalk.red('✗')} ${chalk.bold(pkg.dirName)} ${chalk.red('rejected')}`,
                    );
                    console.log(chalk.gray('      run "findings" to see why'));
                }

                for (const pkg of response.shadowed ?? []) {
                    console.log(
                        chalk.gray(
                            `  ○ ${pkg.dirName} shadowed — "${pkg.name}" was already provided by an earlier directory`,
                        ),
                    );
                }
            } catch (error) {
                handleCliError(error);
                process.exit(1);
            }
        });
}

function buildFindingsCommand(): Command {
    return new Command('findings')
        .description('Show every validation finding across installed packages')
        .action(async () => {
            try {
                await requireAuth();
                const spinner = ora('Collecting findings…').start();
                const response = (await api().get('/agent-plugins/findings')) as {
                    enabled?: boolean;
                    findings?: Array<{
                        package?: string;
                        packageLoaded?: boolean;
                        severity?: string;
                        code?: string;
                        message?: string;
                        subject?: string;
                    }>;
                };
                spinner.stop();

                if (reportedDisabled(response.enabled)) {
                    return;
                }

                const findings = response.findings ?? [];
                if (findings.length === 0) {
                    console.log(chalk.green('\nNo findings — every package validated cleanly.'));
                    return;
                }

                console.log(chalk.cyan.bold(`\nFindings (${findings.length})\n`));
                for (const finding of findings) {
                    const tone =
                        finding.severity === 'fatal'
                            ? chalk.red
                            : finding.severity === 'error'
                              ? chalk.yellow
                              : chalk.gray;
                    const subject = finding.subject ? chalk.gray(` [${finding.subject}]`) : '';
                    console.log(
                        `  ${tone((finding.severity ?? '?').padEnd(8))} ${chalk.bold(finding.package)}${subject}`,
                    );
                    console.log(`      ${finding.message}`);
                    console.log(chalk.gray(`      ${finding.code}`));
                }
            } catch (error) {
                handleCliError(error);
                process.exit(1);
            }
        });
}

function buildCatalogCommand(): Command {
    return new Command('catalog')
        .description('Show the skills these packages contribute to the catalog')
        .option('-s, --search <text>', 'Filter entries')
        .action(async (options: { search?: string }) => {
            try {
                await requireAuth();
                const spinner = ora('Building catalog entries…').start();
                const query = options.search ? `?search=${encodeURIComponent(options.search)}` : '';
                const response = (await api().get(`/agent-plugins/catalog${query}`)) as {
                    entries?: Array<{
                        slug?: string;
                        description?: string;
                        packageName?: string;
                        packageVersion?: string;
                    }>;
                    total?: number;
                };
                spinner.stop();

                const entries = response.entries ?? [];
                if (entries.length === 0) {
                    console.log(chalk.gray('\nNo package skills in the catalog.'));
                    return;
                }

                console.log(chalk.cyan.bold(`\nPackage skills (${entries.length})\n`));
                for (const entry of entries) {
                    const from = entry.packageName
                        ? chalk.gray(
                              ` — from ${entry.packageName}${entry.packageVersion ? ` ${entry.packageVersion}` : ''}`,
                          )
                        : '';
                    console.log(`  ${chalk.green('●')} ${chalk.bold(entry.slug)}${from}`);
                    if (entry.description) {
                        console.log(chalk.gray(`      ${entry.description}`));
                    }
                }
            } catch (error) {
                handleCliError(error);
                process.exit(1);
            }
        });
}

function buildDescriptorCommand(): Command {
    return new Command('descriptor')
        .description('Write the Ever Works MCP server as an Agent Plugins package')
        .option('-o, --output <dir>', 'Write here instead of ./ever-works-mcp')
        .option('-u, --url <url>', 'Point at a self-hosted MCP endpoint')
        .action(async (options: { output?: string; url?: string }) => {
            try {
                await requireAuth();
                const spinner = ora('Building descriptor…').start();
                const query = options.url ? `?url=${encodeURIComponent(options.url)}` : '';
                const response = (await api().get(`/agent-plugins/descriptor${query}`)) as {
                    files?: Record<string, string>;
                };
                spinner.stop();

                const files = response.files ?? {};
                if (Object.keys(files).length === 0) {
                    console.log(chalk.yellow('\nThe server returned an empty descriptor.'));
                    return;
                }

                // A DIRECTORY, not an archive. A package IS a directory — every
                // client that consumes one reads it as a tree — so writing the
                // tree is both the useful output and the inspectable one.
                // Zipping would also mean a bundling dependency the CLI does
                // not otherwise carry, for a step `zip -r` already does.
                const target = options.output ?? 'ever-works-mcp';
                const { mkdir, writeFile } = await import('node:fs/promises');
                const { dirname, join } = await import('node:path');

                for (const [name, content] of Object.entries(files)) {
                    const file = join(target, name);
                    await mkdir(dirname(file), { recursive: true });
                    await writeFile(file, content, 'utf8');
                }

                console.log(chalk.green(`\nWrote ${target}/`));
                for (const name of Object.keys(files).sort()) {
                    console.log(chalk.gray(`  ${name}`));
                }
                console.log(
                    chalk.gray('  Contains no credentials — your client supplies its own (AP-15).'),
                );
            } catch (error) {
                handleCliError(error);
                process.exit(1);
            }
        });
}

/** The `agent-plugins` subcommand group, for mounting on `plugins`. */
export function buildAgentPluginsCommand(): Command {
    const command = new Command('agent-plugins').description(
        'Inspect Agent Plugins packages (the open cross-vendor skills + MCP format)',
    );
    command.addCommand(buildListCommand());
    command.addCommand(buildFindingsCommand());
    command.addCommand(buildCatalogCommand());
    command.addCommand(buildDescriptorCommand());
    return command;
}
