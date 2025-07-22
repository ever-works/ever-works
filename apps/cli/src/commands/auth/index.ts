import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

interface Credentials {
    token: string;
    apiUrl: string;
    expiresAt?: string;
}

const CREDENTIALS_DIR = path.join(os.homedir(), '.ever-works');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, '.credentials.json');

export const authCommand = new Command('auth')
    .description('Authentication commands')
    .addCommand(
        new Command('login')
            .description('Login to Ever Works API')
            .option('--api-url <url>', 'API URL', process.env.API_URL || 'http://localhost:3000')
            .action(async (options) => {
                try {
                    console.log(chalk.cyan.bold('\n🔐 Ever Works Login\n'));

                    const answers = await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'apiUrl',
                            message: 'API URL:',
                            default: options.apiUrl,
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

                    // Ensure credentials directory exists
                    await fs.ensureDir(CREDENTIALS_DIR);

                    // Save credentials (abstract implementation for now)
                    const credentials: Credentials = {
                        token: answers.token,
                        apiUrl: answers.apiUrl,
                        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
                    };

                    await fs.writeJson(CREDENTIALS_FILE, credentials, { spaces: 2 });

                    console.log(chalk.green('\n✓ Successfully logged in!'));
                    console.log(chalk.gray(`Credentials saved to: ${CREDENTIALS_FILE}`));
                } catch (error) {
                    console.error(chalk.red('\n✗ Login failed:'), error.message);
                    process.exit(1);
                }
            }),
    )
    .addCommand(
        new Command('logout').description('Logout from Ever Works API').action(async () => {
            try {
                console.log(chalk.cyan.bold('\n🔓 Ever Works Logout\n'));

                if (await fs.pathExists(CREDENTIALS_FILE)) {
                    await fs.remove(CREDENTIALS_FILE);
                    console.log(chalk.green('✓ Successfully logged out!'));
                } else {
                    console.log(chalk.yellow('⚠ No active session found.'));
                }
            } catch (error) {
                console.error(chalk.red('\n✗ Logout failed:'), error.message);
                process.exit(1);
            }
        }),
    );

export async function getCredentials(): Promise<Credentials | null> {
    try {
        if (!(await fs.pathExists(CREDENTIALS_FILE))) {
            return null;
        }

        const credentials = await fs.readJson(CREDENTIALS_FILE);

        // Check if token is expired
        if (credentials.expiresAt && new Date(credentials.expiresAt) < new Date()) {
            console.log(chalk.yellow('⚠ Token has expired. Please login again.'));
            return null;
        }

        return credentials;
    } catch (error) {
        console.error(chalk.red('Error reading credentials:'), error.message);
        return null;
    }
}

export async function requireAuth(): Promise<void> {
    const credentials = await getCredentials();
    if (!credentials) {
        //TODO: Uncomment this when customer authentication is supported by the API.
        // console.error(
        //     chalk.red('\n✗ Not authenticated. Please run "ever-works auth login" first.'),
        // );
        // process.exit(1);
    }
}
