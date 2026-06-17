import { Command, CommandRunner } from 'nest-commander';
import { BackfillManagedSubdomainSubCommand } from './backfill-managed-subdomain.subcommand';

/**
 * EW-736 — one-off operational backfills.
 *
 * Each subcommand is idempotent and dry-run by default. See the individual
 * subcommand files for the per-task runbook.
 */
@Command({
    name: 'backfill',
    description: 'One-off operational backfill commands',
    subCommands: [BackfillManagedSubdomainSubCommand],
})
export class BackfillCommand extends CommandRunner {
    async run(): Promise<void> {
        console.log('Available backfill commands:');
        console.log('  managed-subdomain   - Backfill works.managedSubdomain from Cloudflare (EW-736)');
        console.log('\nUse "backfill <command> --help" for more information about a command.');
    }
}
