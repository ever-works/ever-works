import 'server-only';
import { sealData, unsealData } from 'iron-session';
import { AUTH_SECRET } from '../constants';

function getPassword(): string {
    const secret = AUTH_SECRET!;
    if (!AUTH_SECRET) {
        throw new Error(
            'COOKIE_SECRET or AUTH_SECRET environment variable is required for cookie encryption',
        );
    }

    // Iron session requires at least 32 characters
    if (secret.length < 32) {
        // Pad the secret to meet minimum requirements
        return secret.padEnd(32, 'everworks-cookie-salt-v1');
    }

    return secret;
}

export async function encrypt(text: string): Promise<string> {
    try {
        return await sealData(text, {
            password: getPassword(),
            ttl: 0, // No expiration for the seal itself (cookies handle their own expiration)
        });
    } catch (error) {
        console.error('Encryption error:', error);
        throw new Error('Failed to encrypt cookie value');
    }
}

export async function decrypt(encryptedText: string): Promise<string> {
    try {
        const unsealed = await unsealData(encryptedText, {
            password: getPassword(),
        });

        // unsealData returns the original value
        return unsealed as string;
    } catch (error) {
        console.error('Decryption error:', error);
        throw new Error('Failed to decrypt cookie value');
    }
}
