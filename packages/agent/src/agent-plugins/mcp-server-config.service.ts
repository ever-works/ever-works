import { Injectable, Logger } from '@nestjs/common';
import {
    expandArgs,
    expandEnvValues,
    expandPlaceholders,
    isToolNamespaceSafeServerName,
    loadPluginPackage,
    PLUGIN_DATA_PLACEHOLDER,
    type ExpansionContext,
    type McpServerConfig,
    type McpServerEntry,
    type McpTransport,
} from '@ever-works/agent-plugins';
import { config } from '../config';
import { loadedPackages, scanConfiguredPackages } from './configured-source';
import type { LocalPackageCandidate } from './local-source';

/**
 * Resolves the MCP servers that installed Agent Plugins packages declare.
 *
 * ## What this does NOT do
 *
 * It does not connect to anything. Resolution and connection are separated
 * because they fail for entirely different reasons and at entirely different
 * times: a malformed `mcp.json` is a fact about installed bytes and is known
 * at scan time, while an unreachable server is a fact about the network and is
 * only known during a run. Merging them would report a package with a typo and
 * a server that happens to be down identically.
 *
 * ## Provenance is part of the result, not a log line
 *
 * Every resolved server carries the package that declared it and the path it
 * came from. An agent about to call a tool named `mcp__api__search` is
 * otherwise unable to say WHERE that tool came from, and neither is the
 * operator reading an audit trail. Provenance that exists only in a log is
 * provenance that cannot be checked at the point of use.
 */

/** A server declared by a package, with everything needed to launch and audit it. */
export interface ResolvedMcpServer {
    /** `mcpServers` member name, unique within its package but NOT globally. */
    readonly name: string;
    /**
     * How this server is addressed in tool names: `mcp__<server>__<tool>`.
     *
     * Null when the name cannot be embedded safely. A name containing the
     * `__` separator would make the tool name ambiguous to split back apart,
     * which could route a call to the wrong server.
     */
    readonly toolNamespace: string | null;
    readonly transport: McpTransport;
    /** Config with `${PLUGIN_ROOT}` already expanded. */
    readonly config: McpServerConfig;
    readonly provenance: McpServerProvenance;
}

export interface McpServerProvenance {
    /** Declaring package's manifest name. */
    readonly packageName: string;
    /** Directory the package occupies, which placeholders resolve against. */
    readonly packageRoot: string;
    readonly packageVersion: string | null;
    readonly specVersion: string;
    /** How the package reached this deployment. */
    readonly sourceKind: 'local' | 'git' | 'npm';
}

/**
 * Why a declared server is not being offered.
 *
 * `disabled-by-policy` is kept distinct from every other code on purpose
 * (AP-19): it means the package is fine and the deployment has chosen not to
 * allow it, which is the one case an operator can act on by changing a
 * setting rather than by fixing a package. Collapsing it into a generic
 * "unsupported" would tell them the opposite — that nothing can be done.
 */
export type SkippedMcpReason =
    | 'disabled-by-policy'
    | 'needs-plugin-data'
    | 'unsafe-namespace'
    | 'unreadable-package'
    | 'unsupported-transport'
    | 'underivable-name'
    | 'unsafe-url'
    | 'name-taken';

export interface SkippedMcpServer {
    readonly name: string;
    readonly packageName: string;
    readonly reason: string;
    readonly code: SkippedMcpReason;
    /**
     * True when the only thing standing between this server and being usable
     * is a deployment setting. Lets a UI offer "enable stdio" instead of
     * "contact the package author".
     */
    readonly enableable: boolean;
}

export interface McpResolutionResult {
    readonly enabled: boolean;
    readonly servers: readonly ResolvedMcpServer[];
    /**
     * Servers that were declared but cannot be offered, each with a reason.
     *
     * Kept separate from `servers` rather than dropped: "this package declares
     * no servers" and "it declares one this deployment refuses" are different
     * facts, and only the second asks an operator to do something.
     */
    readonly skipped: readonly SkippedMcpServer[];
}

/**
 * True when any string in the config still references `${PLUGIN_DATA}`.
 *
 * Checked BEFORE expansion, because expansion cannot fail — it substitutes
 * whatever the context holds. Passing a placeholder path for a directory
 * nothing has allocated would produce a server that dies at launch with a
 * confusing filesystem error; refusing it up front produces a reason an
 * operator can act on.
 */
export function usesPluginData(config: McpServerConfig): boolean {
    const values: string[] =
        config.type === 'stdio'
            ? [
                  config.command,
                  ...(config.args ?? []),
                  ...Object.values(config.env ?? {}),
                  ...(config.cwd ? [config.cwd] : []),
              ]
            : [config.url, ...Object.values(config.headers ?? {})];

    return values.some((value) => value.includes(PLUGIN_DATA_PLACEHOLDER));
}

@Injectable()
export class McpServerConfigService {
    private readonly logger = new Logger(McpServerConfigService.name);

    /**
     * Every MCP server declared by every installed package.
     *
     * Returns `enabled: false` and nothing else when the feature is off, so a
     * caller can tell that apart from "on, with no servers" — otherwise the
     * same empty list.
     */
    async resolveAll(): Promise<McpResolutionResult> {
        const scan = await scanConfiguredPackages();
        if (!scan.enabled) {
            return { enabled: false, servers: [], skipped: [] };
        }

        const servers: ResolvedMcpServer[] = [];
        const skipped: SkippedMcpServer[] = [];

        for (const candidate of loadedPackages(scan)) {
            // The scan carries server NAMES only, so the package is re-read
            // here for the full validated entries. Re-reading also means a
            // package edited since the scan is resolved as it is now rather
            // than as it was, which is what a launcher needs.
            const entries = await this.entriesFor(candidate, skipped);
            for (const entry of entries) {
                const resolved = this.resolveOne(entry, candidate);
                if ('reason' in resolved) {
                    skipped.push(resolved);
                    this.logger.warn(
                        `MCP server "${entry.name}" from "${resolved.packageName}" skipped: ${resolved.reason}`,
                    );
                } else {
                    servers.push(resolved);
                }
            }
        }

        return { enabled: true, servers, skipped };
    }

    /** The servers declared by one package, by manifest name. */
    async resolveForPackage(packageName: string): Promise<readonly ResolvedMcpServer[]> {
        const all = await this.resolveAll();
        return all.servers.filter((server) => server.provenance.packageName === packageName);
    }

    private async entriesFor(
        candidate: LocalPackageCandidate,
        skipped: SkippedMcpServer[],
    ): Promise<readonly McpServerEntry[]> {
        if (candidate.mcpServerNames.length === 0) {
            return [];
        }
        try {
            const load = await loadPluginPackage(candidate.path);
            return load.ok ? load.mcpServers : [];
        } catch (err) {
            // One unreadable package must not cost every other package its
            // servers, so this is reported rather than thrown.
            const reason = err instanceof Error ? err.message : String(err);
            for (const name of candidate.mcpServerNames) {
                skipped.push({
                    name,
                    packageName: candidate.name ?? candidate.dirName,
                    reason: `Package could not be re-read: ${reason}`,
                    code: 'unreadable-package',
                    enableable: false,
                });
            }
            return [];
        }
    }

    private resolveOne(
        entry: McpServerEntry,
        pkg: LocalPackageCandidate,
    ): ResolvedMcpServer | SkippedMcpServer {
        const packageName = pkg.name ?? pkg.dirName;

        // AP-19: a stdio server on a deployment that has not allowed stdio is
        // PRESENT and DISABLED, not absent. The operator should be able to see
        // what a package would run before deciding whether to allow it.
        if (entry.transport === 'stdio' && !config.agentPlugins.isStdioEnabled()) {
            return {
                name: entry.name,
                packageName,
                reason:
                    'Stdio servers are disabled by policy on this deployment. Launching one ' +
                    'executes a subprocess from package contents, so it is gated separately ' +
                    'from Agent Plugins support itself (AGENT_PLUGINS_STDIO).',
                code: 'disabled-by-policy',
                enableable: true,
            };
        }

        // `${PLUGIN_DATA}` is per (owner, package), and this resolver has no
        // owner — it answers "what does this package declare", not "what will
        // this user run". So it cannot supply the value, and the right
        // behaviour depends on who can:
        //
        // - a STDIO server is expanded by the launcher, which does know the
        //   owner, so the placeholder is left INTACT here for it to resolve;
        // - a REMOTE server has no launcher. A `${PLUGIN_DATA}` in a URL or a
        //   header is unresolvable by anyone, so it is refused.
        //
        // This previously refused BOTH, with the reason "this deployment does
        // not yet allocate a per-package data directory" — true when it was
        // written and false once T29 landed, which would have rejected a
        // perfectly good stdio package for a stale reason.
        if (entry.transport !== 'stdio' && usesPluginData(entry.config)) {
            return {
                name: entry.name,
                packageName,
                reason:
                    'A remote server references ${PLUGIN_DATA}, which only a launched ' +
                    'subprocess can resolve — nothing can supply it for a URL or header.',
                code: 'needs-plugin-data',
                enableable: false,
            };
        }

        return {
            name: entry.name,
            toolNamespace: isToolNamespaceSafeServerName(entry.name) ? entry.name : null,
            transport: entry.transport,
            config: this.expand(entry.config, pkg.path),
            provenance: {
                packageName,
                packageRoot: pkg.path,
                packageVersion: pkg.version ?? null,
                specVersion: pkg.specVersion ?? 'unknown',
                // Only local packages are scanned from disk today; git and npm
                // packages land in a scanned directory too, so this widens
                // when the registry row is consulted here.
                sourceKind: 'local',
            },
        };
    }

    /**
     * Substitute `${PLUGIN_ROOT}`, and deliberately leave `${PLUGIN_DATA}`
     * alone.
     *
     * The expansion helpers substitute BOTH placeholders unconditionally —
     * they have no notion of "leave this one". Passing the placeholder as its
     * own replacement is what makes the substitution a no-op, so a stdio
     * config reaches the launcher with `${PLUGIN_DATA}` still in it and the
     * launcher resolves it against the real per-(owner, package) directory.
     *
     * Passing an empty string here, as this once did, silently turned
     * `${PLUGIN_DATA}/db.sqlite` into `/db.sqlite` — an absolute path at the
     * filesystem root.
     */
    private expand(config: McpServerConfig, packageRoot: string): McpServerConfig {
        const context: ExpansionContext = {
            pluginRoot: packageRoot,
            pluginData: PLUGIN_DATA_PLACEHOLDER,
        };

        if (config.type === 'stdio') {
            return {
                ...config,
                command: expandPlaceholders(config.command, context),
                ...(config.args ? { args: expandArgs(config.args, context) } : {}),
                ...(config.env ? { env: expandEnvValues(config.env, context) } : {}),
                ...(config.cwd ? { cwd: expandPlaceholders(config.cwd, context) } : {}),
            };
        }

        return { ...config, url: expandPlaceholders(config.url, context) };
    }
}
