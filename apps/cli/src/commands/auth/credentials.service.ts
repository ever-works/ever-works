import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { isJWTExpired, getJWTExpiration, getJWTUserInfo, AuthUser } from '../../utils/jwt.utils';
import { API_URL } from '../../utils/constants';

export interface Credentials {
    token: string;
    apiUrl: string;
    email?: string;
    username?: string;
    provider?: string;
    emailVerified?: boolean;
    isActive?: boolean;
    avatar?: string | null;
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

            // Validate credentials structure
            if (!credentials || typeof credentials !== 'object') {
                await this.remove();
                return null;
            }

            // Check if token exists
            if (
                !credentials.token ||
                typeof credentials.token !== 'string' ||
                credentials.token.trim() === ''
            ) {
                await this.remove();
                return null;
            }

            // Validate token format (basic JWT structure check)
            const tokenParts = credentials.token.split('.');
            if (tokenParts.length !== 3) {
                await this.remove();
                return null;
            }

            // Check if JWT token is expired
            try {
                if (isJWTExpired(credentials.token)) {
                    await this.remove();
                    return null;
                }
            } catch (jwtError) {
                await this.remove();
                return null;
            }

            // Ensure apiUrl exists
            if (!credentials.apiUrl) {
                credentials.apiUrl = API_URL;
                await this.save(credentials); // Update with default API URL
            }

            return credentials;
        } catch (error) {
            try {
                await this.remove();
            } catch (removeError) {
                // Ignore removal errors
            }

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

    static createWithExpiry(token: string, apiUrl: string, overrideEmail?: string): Credentials {
        // Extract all user info from JWT token
        const userInfo = getJWTUserInfo(token);
        const expiration = getJWTExpiration(token);

        return {
            token,
            apiUrl,
            email: overrideEmail || userInfo?.email,
            username: userInfo?.username,
            provider: userInfo?.provider,
            emailVerified: userInfo?.emailVerified,
            isActive: userInfo?.isActive,
            avatar: userInfo?.avatar,
            expiresAt: expiration ? expiration.toISOString() : undefined,
        };
    }

    static extractUserFromToken(token: string): Partial<AuthUser> | null {
        return getJWTUserInfo(token);
    }

    static async requireAuth(): Promise<Credentials> {
        const credentials = await this.get();
        if (!credentials) {
            console.error(
                chalk.red('\n✗ Not authenticated. Please run "ever-works auth login" first.'),
            );
            process.exit(1);
        }

        return credentials;
    }

    static getTokenExpiryInfo(credentials: Credentials): {
        isExpired: boolean;
        daysLeft?: number;
        hoursLeft?: number;
        minutesLeft?: number;
    } {
        // Get expiration from JWT token
        const expiresDate = getJWTExpiration(credentials.token);

        if (!expiresDate) {
            // Fallback to stored expiresAt if JWT doesn't have exp claim
            if (!credentials.expiresAt) {
                return { isExpired: false };
            }
            const storedExpiry = new Date(credentials.expiresAt);
            const now = new Date();
            const msLeft = storedExpiry.getTime() - now.getTime();
            const daysLeft = Math.floor(msLeft / (1000 * 60 * 60 * 24));
            const hoursLeft = Math.floor((msLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutesLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));

            return {
                isExpired: msLeft <= 0,
                daysLeft: daysLeft > 0 ? daysLeft : undefined,
                hoursLeft: daysLeft === 0 && hoursLeft > 0 ? hoursLeft : undefined,
                minutesLeft:
                    daysLeft === 0 && hoursLeft === 0 && minutesLeft > 0 ? minutesLeft : undefined,
            };
        }

        const now = new Date();
        const msLeft = expiresDate.getTime() - now.getTime();
        const daysLeft = Math.floor(msLeft / (1000 * 60 * 60 * 24));
        const hoursLeft = Math.floor((msLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutesLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));

        return {
            isExpired: msLeft <= 0,
            daysLeft: daysLeft > 0 ? daysLeft : undefined,
            hoursLeft: daysLeft === 0 && hoursLeft > 0 ? hoursLeft : undefined,
            minutesLeft:
                daysLeft === 0 && hoursLeft === 0 && minutesLeft > 0 ? minutesLeft : undefined,
        };
    }
}

// Export for backward compatibility
export const getCredentials: typeof CredentialsService.get =
    CredentialsService.get.bind(CredentialsService);

export const requireAuth: typeof CredentialsService.requireAuth =
    CredentialsService.requireAuth.bind(CredentialsService);
