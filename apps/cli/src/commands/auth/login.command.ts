import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { API_URL } from '../../utils/constants';
import { getApiService } from '../../services/api.service';
import { CredentialsService } from './credentials.service';
import { performOAuthFlow } from './oauth.service';

async function checkExistingLogin(): Promise<boolean> {
    const existingCredentials = await CredentialsService.get();
    if (existingCredentials && existingCredentials.email) {
        console.log(chalk.yellow(`⚠ You are already logged in as ${chalk.bold(existingCredentials.email)}`));
        
        const { proceed } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                message: 'Do you want to login with a different account?',
                default: false,
            },
        ]);
        
        if (!proceed) {
            console.log(chalk.gray('Login cancelled.'));
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

    // Save credentials
    const credentials = CredentialsService.createWithExpiry(
        answers.token,
        answers.apiUrl
    );

    await CredentialsService.save(credentials);

    console.log(chalk.green('\n✓ Successfully logged in!'));
    console.log(chalk.gray(`Credentials saved to: ${CredentialsService.credentialsPath}`));
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
            profile.email || profile.username || 'User'
        );
        
        await CredentialsService.save(credentials);
        
        console.log(chalk.green(`\n✓ Successfully logged in as ${chalk.bold(credentials.email)}!`));
        console.log(chalk.gray(`Credentials saved to: ${CredentialsService.credentialsPath}`));
    } catch (error) {
        // If profile fetch fails, still save the token but without email
        const credentials = CredentialsService.createWithExpiry(sessionToken, apiUrl);
        
        await CredentialsService.save(credentials);
        
        console.log(chalk.green('\n✓ Successfully logged in!'));
        console.log(chalk.yellow('⚠ Could not fetch user profile, but authentication was successful.'));
        console.log(chalk.gray(`Credentials saved to: ${CredentialsService.credentialsPath}`));
    }
}

export const loginCommand = new Command('login')
    .description('Login to Ever Works API')
    .option('--api-url <url>', 'API URL', API_URL)
    .option('--manual', 'Manual token entry (skip OAuth flow)')
    .action(async (options) => {
        try {
            console.log(chalk.cyan.bold('\n🔐 Ever Works Login\n'));

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
            console.error(chalk.red('\n✗ Login failed:'), error.message);
            process.exit(1);
        }
    });