import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { SkillCatalogEntry, SkillCatalogUpdate, SkillFrontmatter } from '@ever-works/plugin';
import type { DiscoveredSkill } from '@ever-works/agent-plugins';
import { discoverSkills } from '@ever-works/agent-plugins';
import { loadedPackages, scanConfiguredPackages } from './configured-source';
import type { LocalPackageCandidate } from './local-source';
import {
    AGENT_PLUGIN_PROVIDER_ID,
    type AgentPluginSkillSource,
    type AgentPluginSkillSourceOptions,
} from './skill-source.token';
import { AgentPluginUpdateService } from './update.service';

/**
 * Turns installed Agent Plugins packages into skills-catalog entries.
 *
 * This is the bridge between two vocabularies: the specification's package
 * of `SKILL.md` files, and Ever Works' `SkillCatalogEntry`. Everything the
 * specification decides — what a valid skill is, which ones to skip, what
 * `allowed-tools` means — is decided by the conformance library; this class
 * only translates.
 *
 * One translation is load-bearing and easy to get wrong: `version`. The
 * catalog requires it, packages need not declare it (the specification
 * explicitly forbids rejecting a package for that), and the column it
 * eventually lands in — `skills.sourceCatalogVersion` — is **varchar(16)**.
 * A content-hash-derived version that is not truncated passes every test in
 * this package and then throws at INSERT the first time somebody clicks
 * Install.
 */
@Injectable()
export class AgentPluginPackageCatalogService implements AgentPluginSkillSource {
    private readonly logger = new Logger(AgentPluginPackageCatalogService.name);

    /**
     * Hard ceiling matching `skills.sourceCatalogVersion`'s column width.
     * Not a style choice — exceeding it is a runtime INSERT failure.
     */
    static readonly MAX_VERSION_LENGTH = 16;

    /**
     * OPTIONAL on purpose. The update service needs a database; this service
     * is also constructed in contexts that have none (the CLI's read-only
     * paths, and every unit test that builds it bare). Making it required
     * would break those call sites, so an absent update service simply means
     * no package updates are reported — the catalog itself is unaffected.
     */
    constructor(@Optional() private readonly updates?: AgentPluginUpdateService) {}

    async listEntries(options: AgentPluginSkillSourceOptions): Promise<SkillCatalogEntry[]> {
        const scan = await scanConfiguredPackages();
        if (!scan.enabled) {
            return [];
        }

        const entries: SkillCatalogEntry[] = [];
        for (const pkg of loadedPackages(scan)) {
            for (const skill of await this.readSkills(pkg)) {
                entries.push(this.toEntry(pkg, skill));
            }
        }

        const filtered = this.applyFilters(entries, options);
        // Stable ordering, so paging through the catalog is deterministic.
        filtered.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
        return filtered;
    }

    async getEntry(
        slug: string,
        options: AgentPluginSkillSourceOptions,
    ): Promise<{ entry: SkillCatalogEntry; providerId: string } | null> {
        // Deliberately routed through the same construction as `listEntries`
        // rather than a separate lookup: if the two ever disagreed about
        // slugs, the catalog would show a card whose Install button 404s.
        const entries = await this.listEntries({ ...options, tags: undefined, search: undefined });
        const entry = entries.find((candidate) => candidate.slug === slug);
        return entry ? { entry, providerId: AGENT_PLUGIN_PROVIDER_ID } : null;
    }

    /**
     * Re-reads a package's skills from disk.
     *
     * The scan records skill NAMES but not bodies, because a catalog listing
     * needs names far more often than it needs 64KB of markdown per skill.
     */
    private async readSkills(pkg: LocalPackageCandidate): Promise<DiscoveredSkill[]> {
        if (pkg.skillNames.length === 0) {
            return [];
        }
        try {
            const result = await discoverSkills(pkg.path);
            return [...result.skills];
        } catch (error) {
            // A package that vanished between scan and read is not an error
            // worth failing a catalog request over.
            this.logger.warn(
                `Agent Plugins package "${pkg.name ?? pkg.dirName}" could not be re-read: ${
                    error instanceof Error ? error.message : error
                }`,
            );
            return [];
        }
    }

    private toEntry(pkg: LocalPackageCandidate, skill: DiscoveredSkill): SkillCatalogEntry {
        const frontmatter: SkillFrontmatter = {
            ...skill.frontmatter,
            name: skill.frontmatter.name,
            description: skill.frontmatter.description,
        };
        if (skill.allowedTools !== undefined) {
            // The specification's wire form is a space-separated string; the
            // platform works in tokens. Converted HERE, at ingest, and
            // nowhere else — a global normalizer would change how existing
            // skills are filtered by tool grants at run time.
            frontmatter.allowedTools = [...skill.allowedTools];
        }

        const entry: SkillCatalogEntry = {
            slug: skill.name,
            title: skill.name,
            description: skill.frontmatter.description,
            frontmatter,
            body: skill.body,
            version: this.entryVersion(pkg),
            tags: this.entryTags(skill),
            sourceKind: 'local',
        };
        if (pkg.name !== undefined) {
            entry.packageName = pkg.name;
        }
        if (pkg.version !== undefined) {
            entry.packageVersion = pkg.version;
        }
        return entry;
    }

    /**
     * The catalog's required `version` for a package skill.
     *
     * A declared package version when there is one; otherwise a short hash of
     * the package identity, so the value still CHANGES when the package does
     * and update detection has something to compare. Always truncated to the
     * storage width.
     */
    private entryVersion(pkg: LocalPackageCandidate): string {
        const declared = pkg.version?.trim();
        if (declared) {
            return declared.slice(0, AgentPluginPackageCatalogService.MAX_VERSION_LENGTH);
        }
        const digest = createHash('sha256')
            .update(`${pkg.name ?? pkg.dirName}:${pkg.path}`)
            .digest('hex');
        return `0.0.0+${digest}`.slice(0, AgentPluginPackageCatalogService.MAX_VERSION_LENGTH);
    }

    private entryTags(skill: DiscoveredSkill): string[] {
        const raw = skill.frontmatter['tags'];
        if (!Array.isArray(raw)) {
            return [];
        }
        return raw.filter((tag): tag is string => typeof tag === 'string');
    }

    private applyFilters(
        entries: SkillCatalogEntry[],
        options: AgentPluginSkillSourceOptions,
    ): SkillCatalogEntry[] {
        let result = entries;

        if (options.tags && options.tags.length > 0) {
            const wanted = new Set(options.tags.map((tag) => tag.toLowerCase()));
            result = result.filter((entry) =>
                entry.tags.some((tag) => wanted.has(tag.toLowerCase())),
            );
        }

        if (options.search && options.search.trim().length > 0) {
            const needle = options.search.trim().toLowerCase();
            result = result.filter(
                (entry) =>
                    entry.slug.toLowerCase().includes(needle) ||
                    entry.title.toLowerCase().includes(needle) ||
                    entry.description.toLowerCase().includes(needle),
            );
        }

        return result;
    }

    /**
     * Package skills with a newer version available.
     *
     * Reports nothing rather than failing when there is no update service or
     * the check fails: an unknown update state must not break the catalog.
     */
    async checkForUpdates(
        installedVersions: Record<string, string>,
        _options: AgentPluginSkillSourceOptions,
    ): Promise<SkillCatalogUpdate[]> {
        if (!this.updates) return [];
        try {
            return await this.updates.checkSkillUpdates(installedVersions);
        } catch (err) {
            this.logger.warn(
                `Package update check failed: ${err instanceof Error ? err.message : err}`,
            );
            return [];
        }
    }
}
