import { Injectable, Logger } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { config } from '../config';
import { parsePackageDirs } from './local-source';
import { AgentPluginPackageRepository } from './package.repository';
import { AgentPluginRemoteAcquireService, type AcquireInput } from './remote-acquire.service';
import type { AgentPluginPackage } from '../entities/agent-plugin-package.entity';

/**
 * Boot-time re-materialisation of remote packages (T19).
 *
 * A pod's filesystem is empty on every start, but the registry rows survive.
 * Without this, a replica that restarts serves a catalog whose package skills
 * have silently vanished — the rows say "installed" and the disk disagrees.
 *
 * ## Why this is time-boxed and non-fatal
 *
 * This runs inside the window Kubernetes gives `startupProbe`. A warmup that
 * blocks on a slow or unreachable registry would fail the probe, and the pod
 * would be killed and restarted into exactly the same stall — a crash loop
 * caused entirely by an optional optimisation. So:
 *
 * - the whole pass is bounded by {@link BUDGET_MS};
 * - individual failures are logged and recorded, never thrown;
 * - the pass is skipped entirely when the feature flag is off.
 *
 * Correctness does not depend on it. A package that is not re-materialised
 * here is simply absent from the catalog until it is fetched again, which is
 * the same state a brand-new replica starts in.
 */

/** Total wall-clock budget for the whole pass. */
export const BUDGET_MS = 20_000;

/** How many packages are fetched at once. */
export const CONCURRENCY = 4;

export interface RematerializeResult {
    attempted: number;
    succeeded: number;
    failed: number;
    /** True when the budget ran out with packages still unprocessed. */
    truncated: boolean;
    skipped: number;
}

@Injectable()
export class AgentPluginPackageBootstrapService {
    private readonly logger = new Logger(AgentPluginPackageBootstrapService.name);

    constructor(
        private readonly repository: AgentPluginPackageRepository,
        private readonly acquirer: AgentPluginRemoteAcquireService,
    ) {}

    /**
     * Re-fetch every remote package whose recorded `installPath` is missing.
     *
     * Idempotent: a package already present on disk is left alone, so calling
     * this twice costs one directory probe per package and no network.
     */
    async rematerializeFromDb(): Promise<RematerializeResult> {
        const empty: RematerializeResult = {
            attempted: 0,
            succeeded: 0,
            failed: 0,
            truncated: false,
            skipped: 0,
        };

        if (!config.agentPlugins.isEnabled()) {
            return empty;
        }

        let rows: AgentPluginPackage[];
        try {
            rows = await this.repository.findRemoteInstalled();
        } catch (err) {
            // The registry being unreadable at boot is a real condition on a
            // replica that starts before the database is reachable. It must
            // not take the pod down.
            this.logger.warn(
                `Agent Plugins re-materialisation skipped — registry unreadable: ${message(err)}`,
            );
            return empty;
        }

        if (rows.length === 0) {
            return empty;
        }

        // The FIRST configured directory is the write target. Re-implementing
        // the split here would drift from `parsePackageDirs`, which handles the
        // platform delimiter and deliberately never treats a bare `:` as one —
        // a Windows path such as `C:\packages` would otherwise be cut in half.
        const roots = parsePackageDirs(config.agentPlugins.getPackageDirs());
        const root = roots[0];
        if (!root) {
            this.logger.warn(
                'Agent Plugins re-materialisation skipped — no package directory configured.',
            );
            return empty;
        }
        const deadline = Date.now() + BUDGET_MS;
        const result = { ...empty };

        // Probe the disk first so an already-warm replica does no network work
        // at all. This is the common case on a rolling restart.
        const missing: AgentPluginPackage[] = [];
        for (const row of rows) {
            if (await presentOnDisk(row.installPath)) {
                result.skipped += 1;
            } else {
                missing.push(row);
            }
        }

        if (missing.length === 0) {
            return result;
        }

        this.logger.log(`Agent Plugins boot warmup: re-materialising ${missing.length} package(s)`);

        for (let i = 0; i < missing.length; i += CONCURRENCY) {
            if (Date.now() >= deadline) {
                result.truncated = true;
                this.logger.warn(
                    `Agent Plugins boot warmup hit its ${BUDGET_MS}ms budget with ` +
                        `${missing.length - result.attempted} package(s) unprocessed. They will ` +
                        `be fetched on demand instead.`,
                );
                break;
            }

            const batch = missing.slice(i, i + CONCURRENCY);
            result.attempted += batch.length;

            const outcomes = await Promise.allSettled(
                batch.map((row) => this.rematerializeOne(root, row)),
            );
            for (const [index, outcome] of outcomes.entries()) {
                if (outcome.status === 'fulfilled') {
                    result.succeeded += 1;
                } else {
                    result.failed += 1;
                    this.logger.warn(
                        `Agent Plugins warmup failed for "${batch[index].name}": ` +
                            `${message(outcome.reason)}`,
                    );
                }
            }
        }

        return result;
    }

    private async rematerializeOne(root: string, row: AgentPluginPackage): Promise<void> {
        const input = acquireInputFor(row);
        if (!input) {
            // An unparseable sourceRef is a data problem, not a transient one;
            // recording it stops the next boot from retrying it forever.
            await this.repository.markFailed(
                row.id,
                `Cannot re-materialise: sourceRef "${row.sourceRef}" is not a valid ${row.source} reference.`,
            );
            return;
        }

        try {
            const acquired = await this.acquirer.acquire(root, input);
            await this.repository.markInstalled(row.id, {
                installPath: acquired.path,
                integrity: acquired.kind === 'npm' ? acquired.integrity : acquired.revision,
                version: acquired.load.ok ? (acquired.load.manifest.version ?? null) : null,
            });
        } catch (err) {
            await this.repository.markFailed(row.id, message(err));
            throw err;
        }
    }
}

/**
 * Rebuild acquisition coordinates from the stored `sourceRef`.
 *
 * `sourceRef` is documented as "a URL with a ref for git, a name with a
 * version for npm". Parsing is deliberately strict: a value that does not
 * match is reported rather than guessed at, because guessing would mean
 * fetching something other than what was recorded.
 */
export function acquireInputFor(row: { source: string; sourceRef: string }): AcquireInput | null {
    const value = row.sourceRef?.trim();
    if (!value) return null;

    if (row.source === 'git') {
        // `<url>#<ref>`. The fragment is used rather than a separator that can
        // appear in a URL path.
        const hash = value.indexOf('#');
        const url = hash === -1 ? value : value.slice(0, hash);
        const ref = hash === -1 ? undefined : value.slice(hash + 1).trim();
        if (!url) return null;
        return { kind: 'git', url, ...(ref ? { ref } : {}) };
    }

    if (row.source === 'npm') {
        // `<name>@<version>`, where the name may itself be scoped and so start
        // with `@`. Splitting on the LAST `@` is what makes `@scope/pkg@1.0.0`
        // parse correctly; splitting on the first would yield an empty name.
        const at = value.lastIndexOf('@');
        if (at <= 0) {
            return { kind: 'npm', packageName: value };
        }
        return {
            kind: 'npm',
            packageName: value.slice(0, at),
            version: value.slice(at + 1),
        };
    }

    return null;
}

async function presentOnDisk(path: string | null | undefined): Promise<boolean> {
    if (!path) return false;
    try {
        const info = await stat(path);
        return info.isDirectory();
    } catch {
        return false;
    }
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
