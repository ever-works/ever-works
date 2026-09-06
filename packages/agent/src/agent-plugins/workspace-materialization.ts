import { join } from 'node:path';
import type { DiscoveredSkill, McpServerEntry } from '@ever-works/agent-plugins';

/**
 * Decides what a package is allowed to place into an agent's workspace (T34).
 *
 * A pure planner, like `buildLaunchPlan`: it returns the set of copies that
 * WOULD be made, and copies nothing. The rule being enforced is an
 * authorisation rule, and an authorisation rule that can only be observed by
 * performing the action is one nobody can test cheaply.
 *
 * ## The execution-gate split
 *
 * Materialising a package into a workspace is not one decision but three,
 * because the three kinds of content carry different authority:
 *
 * - **`references/` and `assets/`** are read by the agent as information.
 *   Copied by default, with executable bits stripped — a reference file has
 *   no reason to be executable, and a file that arrives executable is a file
 *   something might run.
 * - **`scripts/`** is code the agent can execute. Copied ONLY for a package
 *   that passes the same gate as a stdio server, because "the agent can run
 *   this" is the same grant whether the process is spawned by us or by the
 *   agent shelling out.
 * - **`.mcp.json`** tells the workspace's own tooling to connect somewhere.
 *   Written ONLY for servers that already have an enabled binding, so the
 *   file cannot become a second, unaudited route to a server the operator
 *   did not authorise.
 *
 * Without the split, installing a package would let it drop an executable
 * script into a workspace an agent is about to run in — which is the stdio
 * grant, obtained without the stdio gate.
 */

/** Where a materialised item comes from and where it goes. */
export interface MaterializedFile {
    /** Absolute path inside the package. */
    readonly source: string;
    /** Workspace-relative destination. */
    readonly destination: string;
    /** False for everything except gated `scripts/` content. */
    readonly executable: boolean;
}

export interface MaterializationPlan {
    readonly files: readonly MaterializedFile[];
    /** `.mcp.json` content, or null when no server qualifies. */
    readonly mcpConfig: string | null;
    /** What was withheld, and why — an operator asking "where is my script?" needs this. */
    readonly withheld: readonly { path: string; reason: string }[];
}

export interface MaterializationInput {
    readonly packageRoot: string;
    readonly skills: readonly DiscoveredSkill[];
    readonly mcpServers: readonly McpServerEntry[];
    /**
     * True only when this package passes the stdio-grade gate. Named for what
     * it authorises rather than for a flag, so a caller has to think about
     * whether it holds rather than forwarding a boolean it did not examine.
     */
    readonly packageMayExecute: boolean;
    /** Server names with an enabled binding. Anything else is withheld. */
    readonly boundServerNames: readonly string[];
}

/** Sidecar directories copied without any execution authority. */
const INERT_SIDECARS = ['references', 'assets'] as const;

/**
 * Build the plan.
 *
 * Skills always materialise: a `SKILL.md` is instructions, which is what the
 * agent is meant to read. Everything else is conditional.
 */
export function planWorkspaceMaterialization(input: MaterializationInput): MaterializationPlan {
    const files: MaterializedFile[] = [];
    const withheld: { path: string; reason: string }[] = [];

    for (const skill of input.skills) {
        const skillRoot = join(input.packageRoot, 'skills', skill.name);
        const target = `.claude/skills/${skill.name}`;

        files.push({
            source: join(skillRoot, 'SKILL.md'),
            destination: `${target}/SKILL.md`,
            executable: false,
        });

        for (const dir of skill.sidecarDirs) {
            if (INERT_SIDECARS.includes(dir as (typeof INERT_SIDECARS)[number])) {
                files.push({
                    source: join(skillRoot, dir),
                    destination: `${target}/${dir}`,
                    // Stripped deliberately: a reference has no reason to be
                    // executable, and a file that arrives executable is a
                    // file something might run.
                    executable: false,
                });
                continue;
            }

            // `scripts/`
            if (!input.packageMayExecute) {
                withheld.push({
                    path: `skills/${skill.name}/${dir}`,
                    reason:
                        'Scripts are executable content. This package has not been granted ' +
                        'execution, so copying them would hand the agent the stdio grant ' +
                        'without the stdio gate.',
                });
                continue;
            }

            files.push({
                source: join(skillRoot, dir),
                destination: `${target}/${dir}`,
                executable: true,
            });
        }
    }

    return {
        files,
        mcpConfig: buildMcpConfig(input, withheld),
        withheld,
    };
}

/**
 * Emit `.mcp.json` for the servers that are actually bound.
 *
 * A server with no enabled binding is withheld rather than written disabled.
 * The workspace's tooling reads this file on its own terms and may not honour
 * whatever "disabled" shape we invented; absence is the only representation
 * every reader agrees on.
 */
function buildMcpConfig(
    input: MaterializationInput,
    withheld: { path: string; reason: string }[],
): string | null {
    const bound = new Set(input.boundServerNames);
    const servers: Record<string, unknown> = {};

    for (const entry of input.mcpServers) {
        if (!bound.has(entry.name)) {
            withheld.push({
                path: `mcp.json#${entry.name}`,
                reason:
                    'The server has no enabled binding, so writing it here would create a ' +
                    'second route to a server the operator did not authorise.',
            });
            continue;
        }
        servers[entry.name] = entry.config;
    }

    if (Object.keys(servers).length === 0) return null;
    return JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
}
