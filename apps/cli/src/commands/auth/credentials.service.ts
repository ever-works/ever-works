import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';

export interface Credentials {
    token: string;
    apiUrl: string;
    email?: string;
    expiresAt?: string;
}

const CREDENTIALS_DIR = path.join(os.homedir(), '.ever-works');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, '.credentials.json');

export class CredentialsService {
    static get credentialsPath(): string {
        return CREDENTIALS_FILE;
    }

    static async ensureCredentialsDir(): Promise<void> {
        await fs.ensureDir(CREDENTIALS_DIR);
    }

    static async save(credentials: Credentials): Promise<void> {
        await this.ensureCredentialsDir();
        await fs.writeJson(CREDENTIALS_FILE, credentials, { spaces: 2 });
    }

    static async get(): Promise<Credentials | null> {
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

    static async remove(): Promise<boolean> {
        if (await fs.pathExists(CREDENTIALS_FILE)) {
            await fs.remove(CREDENTIALS_FILE);
            return true;
        }
        return false;
    }

    static async exists(): Promise<boolean> {
        return fs.pathExists(CREDENTIALS_FILE);
    }

    static async update(updates: Partial<Credentials>): Promise<void> {
        const current = await this.get();
        if (current) {
            await this.save({ ...current, ...updates });
        }
    }

    static createWithExpiry(token: string, apiUrl: string, email?: string): Credentials {
        return {
            token,
            apiUrl,
            email,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
        };
    }

    static async requireAuth(): Promise<void> {
        const credentials = await this.get();
        if (!credentials) {
            console.error(
                chalk.red('\n✗ Not authenticated. Please run "ever-works auth login" first.'),
            );
            process.exit(1);
        }
    }

    static getTokenExpiryInfo(credentials: Credentials): {
        isExpired: boolean;
        daysLeft?: number;
    } {
        if (!credentials.expiresAt) {
            return { isExpired: false };
        }

        const expiresDate = new Date(credentials.expiresAt);
        const now = new Date();
        const daysLeft = Math.ceil((expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        return {
            isExpired: daysLeft <= 0,
            daysLeft: daysLeft > 0 ? daysLeft : undefined,
        };
    }
}

// Export for backward compatibility
export const getCredentials = CredentialsService.get.bind(CredentialsService);
export const requireAuth = CredentialsService.requireAuth.bind(CredentialsService);
