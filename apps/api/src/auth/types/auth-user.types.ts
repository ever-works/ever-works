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
