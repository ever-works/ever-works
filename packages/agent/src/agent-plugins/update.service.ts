import { Injectable, Logger } from '@nestjs/common';
import type { SkillCatalogUpdate } from '@ever-works/plugin';
import { config } from '../config';
import { AgentPluginPackageRepository } from './package.repository';
import { AgentPluginGitSource } from './git-source';
import { AgentPluginNpmSource } from './npm-source';
import { acquireInputFor } from './package-bootstrap.service';
import type { AgentPluginPackage } from '../entities/agent-plugin-package.entity';

/**
 * Update detection for remote Agent Plugins packages (T20).
 *
 * ## Reporting an update is not the same as applying one
 *
 * Nothing here fetches or installs. It answers "is there something newer?"
 * and stops, because upgrading a package changes the instructions an agent
 * will follow — that has to be an explicit human decision, not a side effect
 * of rendering a page. The re-sync action is separate and deliberate.
 *
 * Consequently every failure here degrades to "no update known" rather than
 * propagating: a registry outage must not break the catalog page, and it must
 * certainly not be reported as "up to date" in a way that hides the outage —
 * hence the `checkedAt`/`unknown` distinction in the result.
 */

export interface PackageUpdate {
    packageId: string;
    name: string;
    source: 'git' | 'npm';
    /** Installed version for npm, installed commit for git. */
    current: string | null;
    /** Available version for npm, remote commit for git. */
    available: string;
}

export interface UpdateCheckResult {
    updates: PackageUpdate[];
    /** Packages whose remote could not be reached — NOT the same as up to date. */
    unknown: Array<{ packageId: string; name: string; reason: string }>;
    checkedAt: Date;
}

/** Cap on how many packages a single check will contact a remote for. */
export const MAX_REMOTE_CHECKS = 50;

@Injectable()
export class AgentPluginUpdateService {
    private readonly logger = new Logger(AgentPluginUpdateService.name);

    constructor(
        private readonly repository: AgentPluginPackageRepository,
        private readonly gitSource: AgentPluginGitSource,
        private readonly npmSource: AgentPluginNpmSource,
    ) {}

    async checkForUpdates(): Promise<UpdateCheckResult> {
        const result: UpdateCheckResult = { updates: [], unknown: [], checkedAt: new Date() };

        if (!config.agentPlugins.isEnabled()) {
            return result;
        }

        let rows: AgentPluginPackage[];
        try {
            rows = await this.repository.findRemoteInstalled();
        } catch (err) {
            this.logger.warn(`Update check skipped — registry unreadable: ${message(err)}`);
            return result;
        }

        const considered = rows.slice(0, MAX_REMOTE_CHECKS);
        if (rows.length > considered.length) {
            this.logger.warn(
                `Update check limited to ${MAX_REMOTE_CHECKS} of ${rows.length} packages.`,
            );
        }

        const outcomes = await Promise.allSettled(considered.map((row) => this.checkOne(row)));

        for (const [index, outcome] of outcomes.entries()) {
            const row = considered[index];
            if (outcome.status === 'rejected') {
                result.unknown.push({
                    packageId: row.id,
                    name: row.name,
                    reason: message(outcome.reason),
                });
                continue;
            }
            if (outcome.value === null) {
                result.unknown.push({
                    packageId: row.id,
                    name: row.name,
                    reason: 'The remote could not be reached, or the update is not permitted.',
                });
                continue;
            }
            if (outcome.value) {
                result.updates.push(outcome.value);
            }
        }

        return result;
    }

    /**
     * @returns the update, `undefined` when already current, or `null` when
     * the remote could not be consulted. The three cases are distinct: an
     * unreachable remote reported as "current" would hide an outage behind a
     * reassuring answer.
     */
    private async checkOne(row: AgentPluginPackage): Promise<PackageUpdate | undefined | null> {
        const input = acquireInputFor(row);
        if (!input) return null;

        if (input.kind === 'npm') {
            const latest = await this.npmSource.latestVersion(input.packageName);
            if (!latest) return null;
            if (latest === row.version) return undefined;
            return {
                packageId: row.id,
                name: row.name,
                source: 'npm',
                current: row.version ?? null,
                available: latest,
            };
        }

        const sha = await this.gitSource.remoteSha(input.url, input.ref);
        if (!sha) return null;
        // For git the recorded `integrity` IS the installed commit — the
        // entity documents that explicitly.
        if (sha === row.integrity) return undefined;
        return {
            packageId: row.id,
            name: row.name,
            source: 'git',
            current: row.integrity ?? null,
            available: sha,
        };
    }

    /**
     * The same check, expressed as catalog updates rather than package ones.
     *
     * A package contributes many skills, so one package update fans out to one
     * `SkillCatalogUpdate` per skill it contributes. `installedVersions` is
     * consulted so a skill the user has NOT installed is not reported as
     * having an update — there is nothing to update.
     */
    async checkSkillUpdates(
        installedVersions: Record<string, string>,
    ): Promise<SkillCatalogUpdate[]> {
        const { updates } = await this.checkForUpdates();
        if (updates.length === 0) return [];

        let rows: AgentPluginPackage[];
        try {
            rows = await this.repository.findRemoteInstalled();
        } catch {
            return [];
        }

        const byId = new Map(rows.map((row) => [row.id, row]));
        const result: SkillCatalogUpdate[] = [];

        for (const update of updates) {
            const row = byId.get(update.packageId);
            for (const slug of row?.skillNames ?? []) {
                const installed = installedVersions[slug];
                if (!installed) continue;
                result.push({
                    slug,
                    oldVersion: installed,
                    // A git commit is not a version string, so it is truncated
                    // to the short form the catalog column can hold. The full
                    // commit stays on the package row.
                    newVersion: shortRevision(update.available),
                });
            }
        }

        return result;
    }
}

/** Catalog version columns are narrow; a 40-character commit does not fit. */
function shortRevision(value: string): string {
    return /^[0-9a-f]{40}$/iu.test(value) ? value.slice(0, 12) : value;
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
