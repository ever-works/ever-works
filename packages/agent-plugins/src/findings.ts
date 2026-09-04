/**
 * Findings — the reporting vocabulary of the Agent Plugins specification.
 *
 * The specification never lets one broken part of a package take down the
 * rest: it defines a precise set of *failure boundaries* (spec 4.1, 6.2,
 * 7.2.2, 11.3) and asks clients to SHOULD-report everything they skip. A
 * finding is one such report, carrying enough structure that a UI can render
 * it per component and a test can assert on it by code rather than by
 * message text.
 */

/**
 * How much of the package a finding invalidates.
 *
 * - `fatal` — the whole package is rejected; nothing is discovered or
 *   executed (spec 5.2, 5.3, 11.3.2).
 * - `error` — a bounded part is unusable: one component type, one skill or
 *   one MCP server entry. Everything else keeps loading.
 * - `warning` — nothing is lost. The report exists because the
 *   specification asks for it (an unknown manifest field, a non-object
 *   `extensions`) or because it helps the operator.
 */
export type FindingSeverity = 'fatal' | 'error' | 'warning';

/**
 * Which failure boundary of spec 4.1 / 7.2.2 a finding belongs to. This maps
 * one-to-one onto the "narrowest applicable failure boundary" list, so a
 * consumer can decide what to drop without re-deriving the rule.
 */
export type FindingScope =
	| 'package'
	| 'manifest'
	| 'skills-component'
	| 'skill'
	| 'mcp-component'
	| 'mcp-server'
	| 'path';

/**
 * Stable finding codes. These are part of the package's public contract:
 * platform code and tests match on them, so treat a rename as a breaking
 * change. Grouped by the specification section that mandates the check.
 */
export type FindingCode =
	// Package model + containment (spec 4.1)
	| 'package.root-unreadable'
	| 'package.path-escapes-root'
	// Manifest (spec 5)
	| 'manifest.missing'
	| 'manifest.unreadable'
	| 'manifest.invalid-json'
	| 'manifest.not-an-object'
	| 'manifest.schema-missing'
	| 'manifest.schema-unsupported'
	| 'manifest.unknown-field'
	| 'manifest.extensions-not-an-object'
	| 'manifest.schema-violation'
	| 'manifest.name-invalid'
	// Component discovery (spec 6.2)
	| 'skills.location-not-a-directory'
	| 'skills.location-unreadable'
	| 'skills.directory-without-skill-md'
	// Skills (spec 7.1 + the Agent Skills specification)
	| 'skill.unreadable'
	| 'skill.frontmatter-missing'
	| 'skill.frontmatter-invalid'
	| 'skill.name-missing'
	| 'skill.name-invalid'
	| 'skill.name-directory-mismatch'
	| 'skill.description-missing'
	| 'skill.description-invalid'
	| 'skill.compatibility-invalid'
	| 'skill.license-invalid'
	| 'skill.metadata-invalid'
	| 'skill.allowed-tools-invalid'
	| 'skill.duplicate-name'
	// MCP configuration (spec 7.2)
	| 'mcp.unreadable'
	| 'mcp.invalid-json'
	| 'mcp.not-an-object'
	| 'mcp.location-not-a-file'
	| 'mcp.schema-missing'
	| 'mcp.schema-unsupported'
	| 'mcp.schema-version-mismatch'
	| 'mcp.unknown-field'
	| 'mcp.servers-missing'
	| 'mcp.servers-not-an-object'
	| 'mcp.server-schema-violation'
	| 'mcp.server-type-missing'
	| 'mcp.server-type-unknown'
	| 'mcp.server-command-invalid'
	| 'mcp.server-cwd-invalid'
	| 'mcp.server-env-reserved-key'
	| 'mcp.server-url-invalid'
	| 'mcp.server-header-name-invalid'
	| 'mcp.server-header-value-invalid'
	| 'mcp.server-header-duplicate'
	| 'mcp.server-transport-unsupported'
	| 'mcp.server-name-invalid'
	// Export / producer side (spec 5.5 + Agent Skills naming)
	| 'export.skill-name-unusable'
	| 'export.plugin-name-unusable';

/** One reported problem, scoped to the part of the package it invalidates. */
export interface Finding {
	readonly code: FindingCode;
	readonly severity: FindingSeverity;
	readonly scope: FindingScope;
	/** Human-readable, safe to show to an operator. Never contains secrets. */
	readonly message: string;
	/**
	 * What the finding is about: a skill name, an MCP server name or a
	 * manifest field name. Absent for package-wide findings.
	 */
	readonly subject?: string;
	/**
	 * Where the problem lives — a package-relative file path (POSIX
	 * separators) or a JSON pointer into the offending document.
	 */
	readonly at?: string;
}

/** Builds a finding, dropping absent optional members so deep-equal tests stay simple. */
export function finding(
	code: FindingCode,
	severity: FindingSeverity,
	scope: FindingScope,
	message: string,
	extra?: { subject?: string; at?: string }
): Finding {
	const result: {
		code: FindingCode;
		severity: FindingSeverity;
		scope: FindingScope;
		message: string;
		subject?: string;
		at?: string;
	} = { code, severity, scope, message };
	if (extra?.subject !== undefined) {
		result.subject = extra.subject;
	}
	if (extra?.at !== undefined) {
		result.at = extra.at;
	}
	return result;
}

/** True when any finding rejects the whole package (spec 11.3.2). */
export function hasFatal(findings: readonly Finding[]): boolean {
	return findings.some((f) => f.severity === 'fatal');
}
