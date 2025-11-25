import { DirectoryConfig } from "./api";

// Site Configuration - Multi-tenant support via environment variables
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || process.env.APP_NAME || 'Ever Works';

// i18n
export const LOCALES = ['en', 'ar', 'de', 'es', 'fr', 'zh'] as const;

export const DEFAULT_LOCALE = (process.env.NEXT_PUBLIC_DEFAULT_LOCALE ||'en') as (typeof LOCALES)[number];

// API URL
const apiUrl = process.env.API_URL || 'http://localhost:3100';
export const API_URL = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;

// Allowed redirect hosts
export const ALLOWED_REDIRECT_URLS = (process.env.ALLOWED_REDIRECT_URLS || 'localhost,127.0.0.1')
    .split(',')
    .map((url) => url.trim());

export const GET_DIRECTORY_LIST_LIMIT = parseInt(
    process.env.NEXT_PUBLIC_DIRECTORY_LIST_LIMIT || '6',
    10,
);

// App URL
export const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL || 'http://localhost:3000';

// AUTH Secret
export const AUTH_SECRET = process.env.COOKIE_SECRET || process.env.AUTH_SECRET;

// Redirect search param key
export const REDIRECT_SEARCH_PARAM = process.env.REDIRECT_SEARCH_PARAM || 'redirect_uri';

// ROUTES
export const ROUTES = {
    // Dashboard routes (these are under (dashboard) route group)
    DASHBOARD: '/',
    DASHBOARD_DIRECTORIES: '/directories',
    DASHBOARD_DIRECTORIES_NEW: '/directories/new',
    DASHBOARD_DIRECTORY: (id: string) => `/directories/${id}`,
    DASHBOARD_DIRECTORY_ITEMS: (id: string) => `/directories/${id}/items`,
    DASHBOARD_DIRECTORY_GENERATOR: (id: string) => `/directories/${id}/generator`,
    DASHBOARD_DIRECTORY_SCHEDULE: (id: string) => `/directories/${id}/schedule`,
    DASHBOARD_DIRECTORY_DEPLOY: (id: string) => `/directories/${id}/deploy`,
    DASHBOARD_DIRECTORY_SETTINGS: (id: string) => `/directories/${id}/settings`,
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
    return new URL(route, WEB_URL).toString();
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



// Site Configuration - can be merged with directory config from config.yml
export const getSiteConfig = (config?: DirectoryConfig | null) => {
    const name = config?.company_name || APP_NAME;
    const website = config?.company_website || WEB_URL;
    return {
        name: name,
        website: website,
        logo: {
            light: config?.logo?.light || process.env.NEXT_PUBLIC_LOGO_LIGHT || '/logo-light.png',
            dark: config?.logo?.dark || process.env.NEXT_PUBLIC_LOGO_DARK || '/logo-ever-work.png',
        },
        favicon: {
            light: config?.favicon?.light || process.env.NEXT_PUBLIC_FAVICON_LIGHT || '/favicon-light.png',
            dark: config?.favicon?.dark || process.env.NEXT_PUBLIC_FAVICON_DARK || '/favicon-dark.png',
        },
        title: config?.title || process.env.NEXT_PUBLIC_SITE_TITLE || name,
        description:
            config?.description || process.env.NEXT_PUBLIC_SITE_DESCRIPTION || 'Build Directories with AI',
        keywords: config?.keywords ||
            (process.env.NEXT_PUBLIC_SITE_KEYWORDS
                ? process.env.NEXT_PUBLIC_SITE_KEYWORDS.split(',').map((k) => k.trim())
                : ['Ever Works', 'Directories', 'AI', 'Automation', 'Productivity', 'Workflow']),
        author: config?.author || process.env.NEXT_PUBLIC_SITE_AUTHOR || name,
        url: website,
        image: config?.image || process.env.NEXT_PUBLIC_SITE_IMAGE || '/logo-light.png',
        twitter: {
            card: (config?.twitter?.card ||
                process.env.NEXT_PUBLIC_TWITTER_CARD ||
                'summary_large_image') as 'summary' | 'summary_large_image',
            title: config?.twitter?.title || process.env.NEXT_PUBLIC_TWITTER_TITLE || name,
            description:
                config?.twitter?.description ||
                process.env.NEXT_PUBLIC_TWITTER_DESCRIPTION ||
                process.env.NEXT_PUBLIC_SITE_DESCRIPTION ||
                'Build Directories with AI',
        },
    } as const;
};

// Default site config (for backward compatibility)
export const SITE_CONFIG = getSiteConfig();
