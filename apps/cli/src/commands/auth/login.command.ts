import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { API_URL } from '../../utils/constants';
import { getApiService, type UserProfile } from '../../services/api.service';
import { CredentialsService } from './credentials.service';
import { performOAuthFlow } from './oauth.service';

async function checkExistingLogin(): Promise<boolean> {
    const existingCredentials = await CredentialsService.get();
    if (existingCredentials) {
        const displayName = existingCredentials.email || existingCredentials.username || 'User';
        console.log(chalk.yellow(`⚠ You are already logged in as ${chalk.bold(displayName)}`));

        const { proceed } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                message: 'Do you want to login with a different account?',
                default: false,
            },
        ]);

        if (!proceed) {
            console.log(chalk.yellow('\nOperation cancelled.'));
            return false;
        }
    }
    return true;
}

async function manualLogin(apiUrl: string): Promise<void> {
    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'apiUrl',
            message: 'API URL:',
            default: apiUrl,
            validate: (input) => {
                try {
                    new URL(input);
                    return true;
                } catch {
                    return 'Please enter a valid URL';
                }
            },
        },
        {
            type: 'password',
            name: 'token',
            message: 'API Token:',
            validate: (input) => input.length > 0 || 'Token is required',
        },
    ]);

    // Security: verify the token against the API before *committing* it as the
    // active login. The shared HTTP client reads the bearer token from disk, so
    // we must write a temporary credentials file to run the probe — capture any
    // existing login first and roll it back if verification fails, so a
    // mistyped/expired token never clobbers a previously valid session.
    const previousCredentials = await CredentialsService.get();
    const tempCredentials = CredentialsService.createWithExpiry(answers.token, answers.apiUrl);
    await CredentialsService.save(tempCredentials);

    console.log(chalk.gray('Verifying credentials...'));

    let profile: UserProfile;
    try {
        const apiService = getApiService();
        profile = await apiService.getProfile();
    } catch (error) {
        // Restore the prior login (or clear) so an unverified token is never
        // left on disk as the active credentials.
        if (previousCredentials) {
            await CredentialsService.save(previousCredentials);
        } else {
            await CredentialsService.remove();
        }
        throw error;
    }

    // Update saved credentials with verified user info
    const credentials = CredentialsService.createWithExpiry(
        answers.token,
        answers.apiUrl,
        profile.email || profile.username || 'User',
    );

    await CredentialsService.save(credentials);

    const displayName = credentials.email || credentials.username || 'User';
    console.log(chalk.green(`\n✓ Successfully logged in as ${chalk.bold(displayName)}!`));
}

async function oauthLogin(apiUrl: string): Promise<void> {
    // Perform OAuth flow
    const sessionToken = await performOAuthFlow();

    // Verify token by fetching profile
    console.log(chalk.gray('Verifying credentials...'));

    // Save credentials temporarily to test
    const tempCredentials = CredentialsService.createWithExpiry(sessionToken, apiUrl);
    await CredentialsService.save(tempCredentials);

    // Get profile to verify and get email
    try {
        const apiService = getApiService();
        const profile = await apiService.getProfile();

        // Update credentials with user info
        const credentials = CredentialsService.createWithExpiry(
            sessionToken,
            apiUrl,
            profile.email || profile.username || 'User',
        );

        await CredentialsService.save(credentials);

        const displayName = credentials.email || credentials.username || 'User';
        console.log(chalk.green(`\n✓ Successfully logged in as ${chalk.bold(displayName)}!`));
    } catch (error) {
        // If profile fetch fails, still save the token but without email
        const credentials = CredentialsService.createWithExpiry(sessionToken, apiUrl);

        await CredentialsService.save(credentials);

        console.log(chalk.green('\n✓ Successfully logged in!'));
        console.log(
            chalk.yellow('⚠ Could not fetch user profile, but authentication was successful.'),
        );
    }
}

export const loginCommand = new Command('login')
    .description('Login to Ever Works API')
    .option('--api-url <url>', 'API URL', API_URL)
    .option('--manual', 'Manual token entry (skip OAuth flow)')
    .action(async (options) => {
        try {
            console.log(chalk.cyan.bold('\nEver Works Login\n'));

            // Check if user is already logged in
            const shouldProceed = await checkExistingLogin();
            if (!shouldProceed) {
                return;
            }

            // Choose login method
            if (options.manual) {
                await manualLogin(options.apiUrl);
            } else {
                await oauthLogin(options.apiUrl);
            }
        } catch (error) {
            console.log(chalk.red('\n✗ Login failed:'), error?.message || error);
            process.exit(1);
        }
    });
