export { AgentPluginsModule } from './agent-plugins.module';

/**
 * Agent Plugins standard interop — the platform side.
 *
 * `@ever-works/agent-plugins` knows the specification and nothing about Ever
 * Works. This module is the other half: it knows Ever Works — tenancy,
 * configuration, persistence, the skills catalog — and calls into that library
 * for every judgement about what the standard permits.
 *
 * The split is deliberate and load-bearing. It is what lets the conformance
 * library be tested against a fixture corpus with no database, and what keeps
 * specification rules from being quietly re-implemented, and subtly differently,
 * inside platform code.
 *
 * Note what this is NOT: a native Ever Works plugin. Native plugins are
 * instantiated bare with no repository access, and the skills-provider
 * capability is scope-blind — so a plugin could neither read the tenant-scoped
 * package registry nor scope it, and package skills would leak across tenants.
 * This is ordinary platform code for exactly that reason.
 */

export { AgentPluginPackageCatalogService } from './package-catalog.service';

export {
    AGENT_PLUGIN_PROVIDER_ID,
    AGENT_PLUGIN_SKILL_SOURCE,
    type AgentPluginSkillSource,
    type AgentPluginSkillSourceOptions,
} from './skill-source.token';

export {
    configuredPackageDirs,
    loadedPackages,
    rejectedPackages,
    scanConfiguredPackages,
    type ConfiguredScanResult,
} from './configured-source';

export {
    DEFAULT_MAX_LOCAL_ENTRIES,
    parsePackageDirs,
    scanLocalPackages,
    scanLocalSources,
    type LocalPackageCandidate,
    type LocalSourceScan,
    type ScanLocalPackagesOptions,
} from './local-source';

export { AgentPluginAllowlistService } from './allowlist.service';

export {
    AgentPluginGitSource,
    gitPackageDir,
    refMatchesPattern,
    validateGitUrl,
    type GitAcquireInput,
    type GitAcquireResult,
    type GitLike,
    type GitUrlCheck,
} from './git-source';

export {
    AgentPluginNpmSource,
    DEFAULT_NPM_REGISTRY,
    npmPackageDir,
    versionPermitted,
    type NpmAcquireInput,
    type NpmAcquireResult,
    type NpmManifest,
    type PacoteLike,
} from './npm-source';

export {
    AgentPluginRemoteAcquireService,
    type AcquireGitInput,
    type AcquireInput,
    type AcquireNpmInput,
    type AcquiredPackage,
    type RemoteSourceKind,
} from './remote-acquire.service';
