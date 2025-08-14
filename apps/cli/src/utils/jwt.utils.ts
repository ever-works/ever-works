export interface AuthUser {
    sub: string;
    email: string;
    provider: string;
    username: string;
    emailVerified: boolean;
    isActive: boolean;
    avatar: string | null;
}

export interface JwtPayload extends AuthUser {
    iat: number;
    iss: string;
    aud: string;
    exp: number;
}

/**
 * Decode a JWT token without verification (for reading payload)
 * Note: This doesn't verify the signature, it just decodes the payload
 */
export function decodeJWT(token: string): JwtPayload | null {
    try {
        // JWT structure: header.payload.signature
        const parts = token.split('.');
        if (parts.length !== 3) {
            return null;
        }

        // Decode the payload (second part)
        const payload = parts[1];

        // Add padding if necessary for base64 decoding
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

        // Decode base64 to JSON
        const decoded = Buffer.from(padded, 'base64').toString('utf-8');
        return JSON.parse(decoded) as JwtPayload;
    } catch (error) {
        console.error('Failed to decode JWT:', error.message);
        return null;
    }
}

/**
 * Check if a JWT token is expired
 */
export function isJWTExpired(token: string): boolean {
    const payload = decodeJWT(token);
    if (!payload || !payload.exp) {
        // If no expiration, assume not expired
        return false;
    }

    // exp is in seconds, Date.now() is in milliseconds
    const now = Math.floor(Date.now() / 1000);
    return payload.exp < now;
}

/**
 * Get JWT expiration date
 */
export function getJWTExpiration(token: string): Date | null {
    const payload = decodeJWT(token);
    if (!payload || !payload.exp) {
        return null;
    }

    // Convert seconds to milliseconds
    return new Date(payload.exp * 1000);
}

/**
 * Get user info from JWT
 */
export function getJWTUserInfo(token: string): AuthUser | null {
    const payload = decodeJWT(token);
    if (!payload) {
        return null;
    }

    return {
        sub: payload.sub,
        email: payload.email,
        provider: payload.provider,
        username: payload.username,
        emailVerified: payload.emailVerified,
        isActive: payload.isActive,
        avatar: payload.avatar,
    };
}

/**
 * Get full JWT payload info
 */
export function getJWTFullInfo(token: string): JwtPayload | null {
    return decodeJWT(token);
}
