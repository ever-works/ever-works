export const LOCALES = ['en', 'de'] as const;

export const DEFAULT_LOCALE = 'en';

const apiUrl = process.env.API_URL || 'http://localhost:3100';
export const API_URL = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;

export const ROUTES = {
    HOME: '/',
    AUTH_LOGIN: '/login',
    AUTH_REGISTER: '/register',
    AUTH_CALLBACK: '/auth/callback',
    AUTH_ERROR: '/auth/error',
    AUTH_EMAIL_CONFIRMATION: '/email-confirmation',
    AUTH_RESET_PASSWORD: '/reset-password',
} as const;

export const PUBLIC_ROUTES = [
    ROUTES.HOME,
    ROUTES.AUTH_LOGIN,
    ROUTES.AUTH_REGISTER,
    ROUTES.AUTH_CALLBACK,
    ROUTES.AUTH_ERROR,
    ROUTES.AUTH_EMAIL_CONFIRMATION,
    '/about',
    '/contact',
    '/privacy',
    '/terms',
    '/help',
] as const;
