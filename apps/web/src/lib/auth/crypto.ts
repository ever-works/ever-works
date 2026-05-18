import 'server-only';
import { sealData, unsealData } from 'iron-session';
import { AUTH_SECRET } from '../constants';

function getPassword(): string {
    const secret = AUTH_SECRET;
    if (!secret) {
        throw new Error(
            'COOKIE_SECRET or AUTH_SECRET environment variable is required for cookie encryption',
        );
    }

    // H-14: previously we silently padded with a literal constant
    // ('everworks-cookie-salt-v1'), so a sub-32-char secret produced a key
    // dominated by a known string. Fail closed instead and force operators
    // to provide proper entropy.
    if (secret.length < 32) {
        throw new Error(
            'COOKIE_SECRET / AUTH_SECRET must be at least 32 characters of high-entropy material ' +
                '(e.g. `openssl rand -base64 48`). The previous behavior of padding short secrets with ' +
                'a fixed string has been removed because it produced a predictable encryption key.',
        );
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
