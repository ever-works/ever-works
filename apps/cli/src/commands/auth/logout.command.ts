import { Command } from 'commander';
import chalk from 'chalk';
import { CredentialsService } from './credentials.service';

export const logoutCommand = new Command('logout')
    .description('Logout from Ever Works API')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n🔓 Ever Works Logout\n'));

            const credentials = await CredentialsService.get();
            const removed = await CredentialsService.remove();

            if (removed) {
                const displayName = credentials?.email || credentials?.username || 'User';
                console.log(
                    chalk.green(`✓ Successfully logged out from ${chalk.bold(displayName)}!`),
                );
            } else {
                console.log(chalk.yellow('⚠ No active session found.'));
            }
        } catch (error) {
            console.error(chalk.red('\n✗ Logout failed:'), error.message);
            process.exit(1);
        }
    });
