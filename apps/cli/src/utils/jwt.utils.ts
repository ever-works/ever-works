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
 *
 * Security: this does NOT verify the signature — it only base64-decodes the
 * payload. The returned claims are UNTRUSTED and must be treated as
 * display-only / best-effort hints (e.g. local email/username display and
 * client-side expiry heuristics). They MUST NOT be used for any authorization
 * decision. Trust is established only by the server, which validates the raw
 * token on every API call; the manual-login path should additionally confirm
 * the token via an authenticated profile fetch before relying on it.
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
    } catch {
        // Security: do not log error.message — for a malformed token it can
        // echo decoded payload/base64 fragments of the credential into stdout,
        // CI logs, or centralized monitoring. Log a fixed, token-free string.
        console.error('Failed to decode JWT:', 'invalid token format');
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
