import 'server-only';
import { jwtDecode } from 'jwt-decode';
import { getAuthAccessCookie } from './cookies';

export type AuthUser = {
    id: string;
    email: string;
    username: string;
    emailVerified: boolean;
    avatar: string | null;
    provider?: string | null;
    isActive?: boolean;
};

export type JwtPayload = {
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
    exp: number;
};

function isLikelyJwt(token: string) {
    return token.split('.').length === 3;
}

export async function getAuthFromRequest(): Promise<{
    isAuthenticated: boolean;
    user?: JwtPayload;
    isExpired: boolean;
    token?: string;
    isOpaqueToken: boolean;
}> {
    try {
        const token = await getAuthAccessCookie();

        if (!token) {
            return { isAuthenticated: false, isExpired: false, isOpaqueToken: false };
        }

        if (!isLikelyJwt(token)) {
            return {
                isAuthenticated: true,
                isExpired: false,
                token,
                isOpaqueToken: true,
            };
        }

        const decoded = jwtDecode<JwtPayload>(token);
        const now = Date.now() / 1000;

        return {
            isAuthenticated: true,
            user: decoded,
            isExpired: decoded.exp < now,
            token,
            isOpaqueToken: false,
        };
    } catch (error) {
        return { isAuthenticated: false, isExpired: false, isOpaqueToken: false };
    }
}
