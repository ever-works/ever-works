export const APP_NAME = 'Ever Works';

// i18n
export const LOCALES = ['en', 'de'] as const;

export const DEFAULT_LOCALE = 'en';

// API URL
const apiUrl = process.env.API_URL || 'http://localhost:3100';
export const API_URL = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;

// Allowed redirect hosts
export const ALLOWED_REDIRECT_URLS = (process.env.ALLOWED_REDIRECT_URLS || 'localhost,127.0.0.1')
    .split(',')
    .map((url) => url.trim());

// App URL
export const APP_URL = process.env.NEXT_PUBLIC_WEB_URL || 'http://localhost:3000';

// AUTH Secret
export const AUTH_SECRET = process.env.COOKIE_SECRET || process.env.AUTH_SECRET;

// Redirect search param key
export const REDIRECT_SEARCH_PARAM = 'redirect_uri';

// ROUTES
export const ROUTES = {
    // Dashboard routes (these are under (dashboard) route group)
    DASHBOARD: '/',
    DASHBOARD_DIRECTORIES: '/directories',
    DASHBOARD_DIRECTORIES_NEW: '/directories/new',
    DASHBOARD_DIRECTORY: (id: string) => `/directories/${id}`,
    // Settings
    DASHBOARD_SETTINGS: '/settings',
    DASHBOARD_SETTINGS_PROFILE: '/settings',
    DASHBOARD_SETTINGS_SECURITY: '/settings/security',
    DASHBOARD_SETTINGS_API_TOKENS: '/settings/api-tokens',
    DASHBOARD_SETTINGS_OAUTH: '/settings/oauth',
    DASHBOARD_SETTINGS_NOTIFICATIONS: '/settings/notifications',
    DASHBOARD_SETTINGS_DANGER_ZONE: '/settings/danger',
    // Profile
    DASHBOARD_PROFILE: '/profile',
    DASHBOARD_ANALYTICS: '/analytics',
    DASHBOARD_NOTIFICATIONS: '/notifications',

    // Auth routes (these are under (auth) route group)
    AUTH_LOGIN: '/login',
    AUTH_REGISTER: '/register',
    AUTH_ERROR: '/auth/error',
    AUTH_EMAIL_CONFIRMATION: '/email-confirmation',
    AUTH_RESET_PASSWORD: '/reset-password',
    AUTH_FORGOT_PASSWORD: '/forgot-password',

    // API routes
    API_AUTH_CALLBACK: '/api/auth/:provider/callback',
    API_AUTH_VERIFY_EMAIL: '/api/auth/verify-email',
    API_AUTH_RESET_PASSWORD: '/api/auth/reset-password',
    API_AI_CONVERSATIONS_ASK_STREAM: '/api/ai-conversations/ask/stream',
    API_AI_CONVERSATIONS_MESSAGE_STREAM: '/api/ai-conversations/:sessionId/stream',
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
    ROUTES.AUTH_FORGOT_PASSWORD,
    '/about',
    '/contact',
    '/privacy',
    '/terms',
    '/help',
] as const;
