/**
 * The whole-package entry point.
 *
 * Everything above this file validates one thing; this file applies them in
 * the order the specification mandates and enforces the one structural rule
 * that spans them: "A client loads and validates root `plugin.json` before
 * discovering components or applying client-specific behavior" (spec 5.1).
 *
 * That order is not cosmetic. A fatal manifest means the client "MUST NOT
 * discover or execute any of its components" (spec 5.3, 11.3.2), so a
 * package with a broken manifest and twenty perfectly good skills
 * contributes nothing. Below the manifest, failure is contained: a broken
 * component type, skill or server never takes anything else down (spec
 * 11.3.3).
 *
 * Component support is a parameter rather than a constant because spec 11.2
 * makes incremental adoption legal — a skills-only client conforms — and
 * Ever Works genuinely needs that: the skills half of the standard reaches
 * users several phases before the package-declared MCP half does.
 */

import { finding, hasFatal, type Finding } from './findings';
import { loadManifest, type AgentPluginManifest } from './manifest';
import { loadMcpConfig, type McpServerEntry, type McpTransport } from './mcp';
import { isDirectory, resolveRealPath } from './paths';
import { discoverSkills, type DiscoveredSkill } from './skills';
import type { SpecVersion } from './versions';

/** Which component types the calling client implements (spec 11.2). */
export interface SupportedComponents {
	readonly skills?: boolean;
	readonly mcpServers?: boolean;
}

export interface LoadPluginPackageOptions {
	/** Defaults to both component types. At least one must be enabled (spec 11.1.8). */
	readonly components?: SupportedComponents;
	/**
	 * Transports the client can connect. Defaults to all three. An entry
	 * declaring an unsupported transport is skipped and reported, not
	 * treated as invalid configuration (spec 7.2.2 rule 4).
	 */
	readonly supportedTransports?: readonly McpTransport[];
}

/** State of one component type after loading. */
export interface ComponentState {
	/** False when the location was present but unusable (spec 6.2). */
	readonly valid: boolean;
	/** True when the fixed location is absent, which is never an error (spec 6.2). */
	readonly absent: boolean;
	/** True when the client did not ask for this component type at all (spec 11.2). */
	readonly unsupported: boolean;
}

/** A successfully loaded package. Individual components may still have been skipped. */
export interface LoadedPluginPackage {
	readonly ok: true;
	/** The filesystem-resolved plugin root, which every containment check is relative to. */
	readonly root: string;
	readonly manifest: AgentPluginManifest;
	readonly specVersion: SpecVersion;
	readonly skills: readonly DiscoveredSkill[];
	readonly skillsComponent: ComponentState;
	readonly mcpServers: readonly McpServerEntry[];
	readonly mcpComponent: ComponentState;
	/** Every report from every stage, in the order produced. */
	readonly findings: readonly Finding[];
}

/** A rejected package: the manifest was fatally invalid, so nothing was discovered. */
export interface RejectedPluginPackage {
	readonly ok: false;
	readonly root: string;
	readonly findings: readonly Finding[];
}

export type LoadPluginPackageResult = LoadedPluginPackage | RejectedPluginPackage;

const UNSUPPORTED: ComponentState = { valid: false, absent: false, unsupported: true };

/**
 * Loads and validates one Agent Plugins package from a directory.
 *
 * Never throws for anything a package author can cause; every problem comes
 * back as a finding. A thrown error from here means a bug in this library or
 * a genuinely broken environment.
 */
export async function loadPluginPackage(
	pluginRoot: string,
	options?: LoadPluginPackageOptions
): Promise<LoadPluginPackageResult> {
	const wantSkills = options?.components?.skills ?? true;
	const wantMcp = options?.components?.mcpServers ?? true;
	if (!wantSkills && !wantMcp) {
		throw new Error(
			'loadPluginPackage requires at least one supported component type; a conformant client supports skills, MCP servers or both (spec 11.1)'
		);
	}

	// Resolve the root once. Everything downstream compares against this
	// value, so a symlinked install directory is handled consistently rather
	// than per check.
	const root = await resolveRealPath(pluginRoot);

	if (!(await isDirectory(root))) {
		return {
			ok: false,
			root,
			findings: [
				finding(
					'package.root-unreadable',
					'fatal',
					'package',
					'The plugin root does not exist or is not a directory; an Agent Plugins package is a directory rooted at a single filesystem location (spec 4.1)'
				)
			]
		};
	}

	const manifestResult = await loadManifest(root);
	if (!manifestResult.ok) {
		return { ok: false, root, findings: manifestResult.findings };
	}

	const findings: Finding[] = [...manifestResult.findings];
	const { manifest, specVersion } = manifestResult;

	let skills: readonly DiscoveredSkill[] = [];
	let skillsComponent: ComponentState = UNSUPPORTED;
	if (wantSkills) {
		const discovered = await discoverSkills(root);
		findings.push(...discovered.findings);
		skills = discovered.skills;
		skillsComponent = {
			valid: discovered.componentValid,
			absent: discovered.componentAbsent,
			unsupported: false
		};
	}

	let mcpServers: readonly McpServerEntry[] = [];
	let mcpComponent: ComponentState = UNSUPPORTED;
	if (wantMcp) {
		const mcp = await loadMcpConfig(root, {
			manifestSpecVersion: specVersion,
			...(options?.supportedTransports === undefined ? {} : { supportedTransports: options.supportedTransports })
		});
		findings.push(...mcp.findings);
		mcpServers = mcp.servers;
		mcpComponent = { valid: mcp.componentValid, absent: mcp.componentAbsent, unsupported: false };
	}

	// Defence in depth: nothing below the manifest is allowed to raise a
	// fatal finding, because fatal means "discover nothing" and by this
	// point discovery has happened. If one ever appears, the contract has
	// been broken and silently returning a loaded package would hide it.
	if (hasFatal(findings)) {
		return { ok: false, root, findings };
	}

	return {
		ok: true,
		root,
		manifest,
		specVersion,
		skills,
		skillsComponent,
		mcpServers,
		mcpComponent,
		findings
	};
}

/** Convenience view of a load result for UI and logs. */
export interface PackageLoadSummary {
	readonly accepted: boolean;
	readonly skillCount: number;
	readonly mcpServerCount: number;
	readonly fatalCount: number;
	readonly errorCount: number;
	readonly warningCount: number;
}

/** Counts findings by severity alongside what was actually loaded. */
export function summarizeLoad(result: LoadPluginPackageResult): PackageLoadSummary {
	const by = (severity: Finding['severity']): number => result.findings.filter((f) => f.severity === severity).length;
	return {
		accepted: result.ok,
		skillCount: result.ok ? result.skills.length : 0,
		mcpServerCount: result.ok ? result.mcpServers.length : 0,
		fatalCount: by('fatal'),
		errorCount: by('error'),
		warningCount: by('warning')
	};
}
