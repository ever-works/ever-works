// i18n
export const LOCALES = ['en', 'de'] as const;

export const DEFAULT_LOCALE = 'en';

// API URL
const apiUrl = process.env.API_URL || 'http://localhost:3100';
export const API_URL = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;

// App URL
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

// ROUTES
export const ROUTES = {
    HOME: '/',
    DIRECTORIES: '/directories',
    DIRECTORY: (slug: string) => `/directories/${slug}`,

    AUTH_LOGIN: '/login',
    AUTH_REGISTER: '/register',
    AUTH_ERROR: '/auth/error',
    AUTH_EMAIL_CONFIRMATION: '/email-confirmation',
    AUTH_RESET_PASSWORD: '/reset-password',
    // NEXTJS API ROUTES
    API_AUTH_CALLBACK: '/api/auth/:provider/callback',
    API_AUTH_VERIFY_EMAIL: '/api/auth/verify-email',
} as const;

export const routeWithParams = (route: string, params: Record<string, string>) => {
    Object.entries(params).forEach(([key, value]) => {
        route = route.replace(`:${key}`, value);
    });
    return route;
};

export const withAppUrl = (route: string) => {
    return new URL(route, APP_URL).toString();
};

export const PUBLIC_ROUTES = [
    ROUTES.AUTH_LOGIN,
    ROUTES.AUTH_REGISTER,
    ROUTES.AUTH_ERROR,
    ROUTES.AUTH_EMAIL_CONFIRMATION,
    ROUTES.AUTH_RESET_PASSWORD,
    '/about',
    '/contact',
    '/privacy',
    '/terms',
    '/help',
] as const;

export const PROTECTED_ROUTES = [ROUTES.HOME, ROUTES.DIRECTORIES] as const;
