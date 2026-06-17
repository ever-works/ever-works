/**
 * EW-736 — backfill subcommand: `cli backfill managed-subdomain [--write]`.
 *
 * Reads every Cloudflare DNS record under the managed zone, matches each
 * to a Work in the DB, and persists `works.managedSubdomain` so the seven
 * legacy `*.ever.works` Works gain the same orphan-on-rename protection
 * that newly-allocated Works get from `SubdomainAllocator` (EW-737).
 *
 * Usage
 * -----
 *
 *   # dry-run (default): print what would be written, persist nothing.
 *   pnpm --filter @ever-works/cli build:cli && \
 *     ./apps/internal-cli/dist/cli.js backfill managed-subdomain
 *
 *   # write the matched managedSubdomain values:
 *   ./apps/internal-cli/dist/cli.js backfill managed-subdomain --write
 *
 * Or from the published CLI:
 *
 *   pnpm dlx @ever-works/cli backfill managed-subdomain --dry-run
 *   pnpm dlx @ever-works/cli backfill managed-subdomain --write
 *
 * When to run
 * -----------
 *  - One-off after migration `1780800000000-AddWorkManagedSubdomain` has
 *    deployed and BEFORE flipping `K8S_MANAGED_SUBDOMAIN=true` in
 *    production. Idempotent + safe to re-run.
 *
 * Required env (read via the same channel as the API/agent providers):
 *   CLOUDFLARE_API_TOKEN          # zone-scoped DNS:Read (DNS:Edit not required for dry-run)
 *   CLOUDFLARE_ZONE_ID            # `ever.works` zone id
 *   EVER_WORKS_DOMAIN             # defaults to `ever.works`
 */

import { SubCommand, CommandRunner, Option } from 'nest-commander';
import { Logger } from '@nestjs/common';
import chalk from 'chalk';
import { WorkRepository } from '@ever-works/agent/database';
import {
    BackfillManagedSubdomainService,
    type BackfillSummary,
    type WorkBackfillReadWrite,
    type CloudflareZoneLister,
} from './backfill-managed-subdomain.service';
import { CloudflareApiZoneLister } from './cloudflare-zone-lister';

const DEFAULT_DEPLOY_PROVIDERS = ['ever-works', 'k8s'] as const;

interface BackfillSubcommandOptions {
    write?: boolean;
    dryRun?: boolean;
}

@SubCommand({
    name: 'managed-subdomain',
    description:
        'Backfill works.managedSubdomain from live Cloudflare DNS (EW-736). Dry-run by default; pass --write to persist.',
})
export class BackfillManagedSubdomainSubCommand extends CommandRunner {
    private readonly logger = new Logger(BackfillManagedSubdomainSubCommand.name);

    constructor(private readonly workRepository: WorkRepository) {
        super();
    }

    async run(_passedParams: string[], options: BackfillSubcommandOptions = {}): Promise<void> {
        try {
            // `--write` is the persist flag. `--dry-run` is accepted as a
            // human-friendly explicit synonym for "the default behaviour"
            // so ops can spell out intent in runbooks.
            const writeMode = options.write === true && options.dryRun !== true;

            console.log(chalk.cyan.bold('\nEW-736 — Backfill works.managedSubdomain\n'));
            console.log(
                writeMode
                    ? chalk.yellow.bold('Mode: WRITE — changes will be persisted')
                    : chalk.gray('Mode: dry-run (no DB writes; pass --write to persist)'),
            );

            const cloudflare = this.buildCloudflareLister();
            const works = this.buildWorkAdapter();
            const service = new BackfillManagedSubdomainService(works, cloudflare, this.logger);

            const summary = await service.run({ write: writeMode });
            this.printSummary(summary, writeMode);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            this.logger.error(`[backfill] failed: ${message}`);
            console.log(chalk.red(`\n✗ Backfill failed: ${message}\n`));
            process.exitCode = 1;
        }
    }

    @Option({
        flags: '--write',
        description: 'Persist the matched managedSubdomain values (default: dry-run).',
    })
    parseWrite(): boolean {
        return true;
    }

    @Option({
        flags: '--dry-run',
        description: 'Explicit dry-run flag (no DB writes). This is the default.',
    })
    parseDryRun(): boolean {
        return true;
    }

    private buildCloudflareLister(): CloudflareZoneLister {
        const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
        const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
        const rootDomain = process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works';

        if (!apiToken || !zoneId) {
            throw new Error(
                'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID must be set to run the managed-subdomain backfill',
            );
        }
        return new CloudflareApiZoneLister({ apiToken, zoneId, rootDomain });
    }

    private buildWorkAdapter(): WorkBackfillReadWrite {
        const repo = this.workRepository;
        return {
            // Re-use the WorkRepository underlying typeorm repo for the
            // deployProvider filter. `findAll()` doesn't filter by provider,
            // so we read the full set and filter in-memory — the deployed
            // set is small (low thousands), and the script is one-off.
            async findCandidatesForBackfill() {
                const all = await repo.findAll({ limit: 50000 });
                const providers = new Set<string>(DEFAULT_DEPLOY_PROVIDERS);
                return all.filter((w) =>
                    providers.has((w.deployProvider ?? '').toString().toLowerCase()),
                );
            },
            async update(id, updateData) {
                return repo.update(id, updateData);
            },
        };
    }

    private printSummary(summary: BackfillSummary, writeMode: boolean): void {
        console.log(chalk.cyan.bold('\nSummary:'));
        console.log(chalk.gray(`  Total scanned:   ${summary.totalScanned}`));
        console.log(chalk.gray(`  Already set:     ${summary.alreadySet}`));
        console.log(chalk.green(`  Matched:         ${summary.matched}`));
        console.log(
            writeMode
                ? chalk.green(`  Persisted:       ${summary.persisted}`)
                : chalk.gray(`  Persisted:       ${summary.persisted} (dry-run)`),
        );
        console.log(chalk.yellow(`  Ambiguous:       ${summary.ambiguous}`));
        console.log(chalk.gray(`  No candidate:    ${summary.noCandidate}`));
        if (!writeMode && summary.matched > 0) {
            console.log(
                chalk.gray('\nRe-run with ') +
                    chalk.cyan('--write') +
                    chalk.gray(' to persist the matched values.\n'),
            );
        } else {
            console.log('');
        }
    }
}
