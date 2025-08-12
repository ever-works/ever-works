import { Command } from 'commander';
import chalk from 'chalk';
import { CredentialsService } from './credentials.service';
import { getApiService } from '../../services/api.service';

export const statusCommand = new Command('status')
    .description('Check authentication status')
    .action(async () => {
        try {
            console.log(chalk.cyan.bold('\n🔍 Authentication Status\n'));

            const credentials = await CredentialsService.get();
            
            if (!credentials) {
                console.log(chalk.yellow('⚠ Not authenticated.'));
                console.log(chalk.gray('Run "ever-works auth login" to authenticate.'));
                return;
            }

            console.log(chalk.green('✓ Authenticated'));
            if (credentials.email) {
                console.log(chalk.gray(`  Email: ${credentials.email}`));
            }
            console.log(chalk.gray(`  API URL: ${credentials.apiUrl}`));
            
            // Check token expiry
            const expiryInfo = CredentialsService.getTokenExpiryInfo(credentials);
            if (expiryInfo.isExpired) {
                console.log(chalk.red(`  Token expired`));
            } else if (expiryInfo.daysLeft !== undefined) {
                console.log(chalk.gray(`  Token expires in: ${expiryInfo.daysLeft} days`));
            }
            
            // Try to verify with API
            console.log(chalk.gray('\nVerifying with API...'));
            try {
                const apiService = getApiService();
                const profile = await apiService.getProfile();
                console.log(chalk.green('✓ Token is valid'));
                
                // Update email if we got it from profile
                if (profile.email && profile.email !== credentials.email) {
                    await CredentialsService.update({ email: profile.email });
                }
            } catch (error) {
                console.log(chalk.red('✗ Token verification failed'));
                console.log(chalk.gray('You may need to login again.'));
            }
            
        } catch (error) {
            console.error(chalk.red('\n✗ Status check failed:'), error.message);
            process.exit(1);
        }
    });