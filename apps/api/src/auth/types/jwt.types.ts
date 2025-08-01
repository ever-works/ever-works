export interface JwtPayload {
    sub: string;                    // User ID (JWT standard)
    email: string;
    provider: string;              // Registration provider
    username: string;
    emailVerified: boolean;
    isActive: boolean;
    avatar: string | null;
    iat: number;                   // Issued at timestamp
    iss: string;                   // Issuer
    aud: string;                   // Audience
}

export interface AuthenticatedUser {
    userId: string;
    email: string;
    username: string;
    provider: string;
    emailVerified: boolean;
    isActive: boolean;
    avatar: string | null;
    iat: number;
    iss: string;
    aud: string;
}

export interface TokenResponse {
    access_token: string;
    refresh_token: string;
    user: {
        id: string;
        email: string;
        username: string;
    };
}