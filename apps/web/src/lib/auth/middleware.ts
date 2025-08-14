import 'server-only';
import { jwtDecode } from 'jwt-decode';
import { getAuthAccessCookie } from './cookies';

export type AuthUser = {
    sub: string;
    email: string;
    provider: string;
    username: string;
    emailVerified: boolean;
    isActive: boolean;
    avatar: string | null;
};

export type JwtPayload = AuthUser & {
    iat: number;
    iss: string;
    aud: string;
    exp: number;
};

export async function getAuthFromRequest(): Promise<{
    isAuthenticated: boolean;
    user?: JwtPayload;
    isExpired: boolean;
    token?: string;
}> {
    try {
        const token = await getAuthAccessCookie();

        if (!token) {
            return { isAuthenticated: false, isExpired: false };
        }

        const decoded = jwtDecode<JwtPayload>(token);
        const now = Date.now() / 1000;

        return {
            isAuthenticated: true,
            user: decoded,
            isExpired: decoded.exp < now,
            token,
        };
    } catch (error) {
        return { isAuthenticated: false, isExpired: false };
    }
}
