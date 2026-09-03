/**
 * `@ever-works/agent-plugins` — a TypeScript reference loader for the
 * [Agent Plugins specification](https://github.com/agentplugins/agent-plugins-spec).
 *
 * The package is deliberately pure: no NestJS, no TypeORM, no database, no
 * network. It knows the standard and nothing about Ever Works, which is what
 * lets it be the single source of truth for conformance and a useful
 * open-source artifact on its own.
 *
 * Start with {@link loadPluginPackage}, which validates a package directory
 * and returns its skills, its MCP servers and every finding. The individual
 * validators are exported too, for callers that hold a document in memory
 * rather than on disk.
 *
 * What it does NOT do, by design: install packages, connect to MCP servers,
 * launch subprocesses, or touch the filesystem outside the package root it
 * is given. Those belong to the platform layers above it, where policy,
 * tenancy and credentials live.
 */

export { finding, hasFatal, type Finding, type FindingCode, type FindingScope, type FindingSeverity } from './findings';

export {
	isValidPluginName,
	loadManifest,
	MANIFEST_FILENAME,
	parseManifest,
	PERMITTED_MANIFEST_FIELDS,
	PLUGIN_NAME_PATTERN,
	validateManifest,
	type AgentPluginAuthor,
	type AgentPluginManifest,
	type ManifestResult
} from './manifest';

export {
	discoverSkills,
	isValidSkillName,
	parseSkillMd,
	SKILL_COMPATIBILITY_MAX_LENGTH,
	SKILL_DESCRIPTION_MAX_LENGTH,
	SKILL_FILENAME,
	SKILL_NAME_MAX_LENGTH,
	SKILL_NAME_PATTERN,
	SKILL_SIDECAR_DIRNAMES,
	SKILLS_DIRNAME,
	tokenizeAllowedTools,
	validateSkillFrontmatter,
	type DiscoveredSkill,
	type SkillFrontmatter,
	type SkillFrontmatterResult,
	type SkillMdResult,
	type SkillSidecarKind,
	type SkillsDiscoveryResult
} from './skills';

export {
	checkServerContainment,
	isLoopbackHost,
	isToolNamespaceSafeServerName,
	loadMcpConfig,
	MCP_CONFIG_FILENAME,
	parseMcpConfig,
	PERMITTED_MCP_FIELDS,
	validateMcpConfig,
	validateRemoteUrl,
	validateStdioCommand,
	type McpConfigResult,
	type McpHttpServer,
	type McpServerConfig,
	type McpServerEntry,
	type McpStdioServer,
	type McpTransport,
	type ParseMcpConfigOptions
} from './mcp';

export {
	classifyCwd,
	expandArgs,
	expandEnvValues,
	expandPlaceholders,
	isReservedEnvKey,
	PLUGIN_DATA_PLACEHOLDER,
	PLUGIN_ROOT_PLACEHOLDER,
	RESERVED_ENV_KEYS,
	type CwdAnchor,
	type ExpansionContext
} from './expand';

export {
	isDirectory,
	isPluginRelative,
	isRegularFile,
	isWithinResolved,
	packageRelative,
	pathExists,
	resolveRealPath,
	resolveWithinRoot,
	type ContainmentFailure,
	type ContainmentResult
} from './paths';

export {
	EVER_WORKS_EXTENSION_NAMESPACE,
	readExtension,
	serializeManifest,
	serializeSkillMd,
	skillToSerializeInput,
	toSpecPluginName,
	toSpecSkillName,
	type NameNarrowing,
	type SerializeManifestInput,
	type SerializeSkillInput
} from './serialize';

export {
	loadPluginPackage,
	summarizeLoad,
	type ComponentState,
	type LoadedPluginPackage,
	type LoadPluginPackageOptions,
	type LoadPluginPackageResult,
	type PackageLoadSummary,
	type RejectedPluginPackage,
	type SupportedComponents
} from './package-loader';

export {
	mcpSchemaId,
	pluginSchemaId,
	PUBLISHED_CONFORMANCE_VERSION,
	specVersionFromMcpSchemaId,
	specVersionFromPluginSchemaId,
	SUPPORTED_SPEC_VERSIONS,
	supportedMcpSchemaIds,
	supportedPluginSchemaIds,
	WORKING_DRAFT_VERSIONS,
	type SpecVersion
} from './versions';

/**
 * The conformance claim this library backs, stated verbatim wherever it
 * appears (specification section 11, ADR-018, product documentation).
 */
export const CONFORMANCE_CLAIM =
	'Agent Plugins v1.0.0 compatible (client: skills + MCP; producer: skills packages, plus the Ever Works MCP-server package descriptor)';
