export interface AuthTokenPayload {
    sub: string;
    email: string;
    provider: string;
    username: string;
    emailVerified: boolean;
    isActive: boolean;
    avatar: string | null;
    iat: number;
    iss: string;
    aud: string;
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
    user: {
        id: string;
        email: string;
        username: string;
    };
}
