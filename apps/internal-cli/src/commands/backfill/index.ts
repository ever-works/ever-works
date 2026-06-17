import { BackfillCommand } from './backfill.command';
import { BackfillManagedSubdomainSubCommand } from './backfill-managed-subdomain.subcommand';

export const BackfillCommands = [...BackfillCommand.registerWithSubCommands()];

export { BackfillCommand, BackfillManagedSubdomainSubCommand };
