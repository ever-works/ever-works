import { Command } from 'commander';
import { loginCommand } from './login.command';
import { logoutCommand } from './logout.command';
import { statusCommand } from './status.command';

// Re-export services for backward compatibility
export { getCredentials, requireAuth } from './credentials.service';

// Main auth command that combines all subcommands
export const authCommand = new Command('auth')
    .description('Authentication commands')
    .addCommand(loginCommand)
    .addCommand(logoutCommand)
    .addCommand(statusCommand);
