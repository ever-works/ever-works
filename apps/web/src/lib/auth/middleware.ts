import { jwtDecode } from 'jwt-decode';
import { getAuthCookie } from './cookies';

export interface JwtPayload {
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
}

export async function getAuthFromRequest(): Promise<{
    isAuthenticated: boolean;
    user?: JwtPayload;
    isExpired: boolean;
}> {
    try {
        const token = await getAuthCookie();

        if (!token) {
            return { isAuthenticated: false, isExpired: false };
        }

        const decoded = jwtDecode<JwtPayload>(token);
        const now = Date.now() / 1000;

        return {
            isAuthenticated: true,
            user: decoded,
            isExpired: decoded.exp < now,
        };
    } catch (error) {
        return { isAuthenticated: false, isExpired: false };
    }
}
