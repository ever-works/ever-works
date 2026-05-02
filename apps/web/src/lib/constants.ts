import { WorkConfig } from './api';

// Site Configuration - Multi-tenant support via environment variables
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || process.env.APP_NAME || 'Ever Works';
export const COMPANY_OWNER =
    process.env.NEXT_PUBLIC_COMPANY_OWNER || process.env.COMPANY_OWNER || 'Ever Co. LTD';
export const COMPANY_OWNER_WEBSITE =
    process.env.NEXT_PUBLIC_COMPANY_OWNER_WEBSITE ||
    process.env.COMPANY_OWNER_WEBSITE ||
    'https://ever.works';

// i18n
export const LOCALES = [
    'en',
    'ar',
    'bg',
    'de',
    'es',
    'fr',
    'he',
    'hi',
    'id',
    'it',
    'ja',
    'ko',
    'nl',
    'pl',
    'pt',
    'ru',
    'th',
    'tr',
    'uk',
    'vi',
    'zh',
] as const;

export const DEFAULT_LOCALE = (process.env.NEXT_PUBLIC_DEFAULT_LOCALE ||
    'en') as (typeof LOCALES)[number];

// API URL
const apiUrl = process.env.API_URL || 'http://localhost:3100';
export const API_URL = apiUrl.endsWith('/api') ? apiUrl : `${apiUrl}/api`;

// Default AI provider used when no provider is explicitly selected
export const DEFAULT_AI_PROVIDER = 'openrouter';

// Allowed redirect hosts
export const ALLOWED_REDIRECT_URLS = (process.env.ALLOWED_REDIRECT_URLS || 'localhost,127.0.0.1')
    .split(',')
    .map((url) => url.trim());

export const GET_WORK_LIST_LIMIT = parseInt(
    process.env.NEXT_PUBLIC_WORK_LIST_LIMIT || '6',
    10,
);

export const ONBOARDING_STORAGE_KEY = 'ever-works-onboarding';

// App URL
export const WEB_URL =
    process.env.NEXT_PUBLIC_WEB_URL || process.env.WEB_URL || 'http://localhost:3000';

// AUTH Secret
export const AUTH_SECRET = process.env.COOKIE_SECRET || process.env.AUTH_SECRET;

// Redirect search param key
export const REDIRECT_SEARCH_PARAM = process.env.REDIRECT_SEARCH_PARAM || 'redirect_uri';

// ROUTES
export const ROUTES = {
    // Dashboard routes (these are under (dashboard) route group)
    DASHBOARD: '/',
    DASHBOARD_ACTIVITY: '/activity',
    DASHBOARD_DIRECTORIES: '/works',
    DASHBOARD_DIRECTORIES_NEW: '/works/new',
    DASHBOARD_WORK: (id: string) => `/works/${id}`,
    DASHBOARD_WORK_ITEMS: (id: string) => `/works/${id}/items`,
    DASHBOARD_WORK_GENERATOR: (id: string) => `/works/${id}/generator`,
    DASHBOARD_WORK_SCHEDULE: (id: string) => `/works/${id}/generator/schedule`,
    DASHBOARD_WORK_HISTORY: (id: string) => `/works/${id}/generator/history`,
    DASHBOARD_WORK_COMPARISONS: (id: string) => `/works/${id}/generator/comparisons`,
    DASHBOARD_WORK_COMPARISON: (id: string, slug: string) =>
        `/works/${id}/generator/comparisons/${slug}`,
    DASHBOARD_WORK_DEPLOY: (id: string) => `/works/${id}/deploy`,
    DASHBOARD_WORK_MEMBERS: (id: string) => `/works/${id}/members`,
    DASHBOARD_WORK_SETTINGS: (id: string) => `/works/${id}/settings`,
    DASHBOARD_WORK_PLUGINS: (id: string) => `/works/${id}/plugins`,
    // Plugins
    DASHBOARD_PLUGINS: '/plugins',
    DASHBOARD_PLUGIN_DETAIL: (pluginId: string) => `/plugins/${pluginId}`,
    // Settings
    DASHBOARD_SETTINGS: '/settings',
    DASHBOARD_SETTINGS_PROFILE: '/settings',
    DASHBOARD_SETTINGS_SECURITY: '/settings/security',
    DASHBOARD_SETTINGS_API_KEYS: '/settings/api-keys',
    DASHBOARD_SETTINGS_DANGER_ZONE: '/settings/danger',
    DASHBOARD_SETTINGS_DATA: '/settings/data',
    DASHBOARD_SETTINGS_GITHUB_APP: '/settings/github-app',
    // Dynamic plugin settings routes
    DASHBOARD_SETTINGS_PLUGIN_CATEGORY: (category: string) => `/settings/plugins/${category}`,
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
    API_AUTH_VERIFY_EMAIL: '/api/auth/verify-email',
    API_AUTH_RESET_PASSWORD: '/api/auth/reset-password',
    API_AUTH_PROVIDER_CALLBACK: '/api/auth/provider/callback/:providerId',
    API_CHAT: '/api/chat',
    API_OAUTH_CALLBACK: '/api/oauth/:providerId/callback',
    API_OAUTH_PLUGINS_CALLBACK: '/api/oauth/:providerId/callback/plugins',
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

// Site Configuration - can be merged with work config from config.yml
export const getSiteConfig = (config?: WorkConfig | null) => {
    const name = config?.company_name || APP_NAME;
    const website = config?.company_website || WEB_URL;
    const owner = config?.company_owner || COMPANY_OWNER;
    const ownerWebsite = config?.company_owner_website || COMPANY_OWNER_WEBSITE;
    return {
        name: name,
        website: website,
        owner: owner,
        ownerWebsite: ownerWebsite,
        logo: {
            light: config?.logo?.light || process.env.NEXT_PUBLIC_LOGO_LIGHT || '/logo-light.png',
            dark: config?.logo?.dark || process.env.NEXT_PUBLIC_LOGO_DARK || '/logo-ever-work.png',
        },
        favicon: {
            light:
                config?.favicon?.light ||
                process.env.NEXT_PUBLIC_FAVICON_LIGHT ||
                '/favicon-light.png',
            dark:
                config?.favicon?.dark ||
                process.env.NEXT_PUBLIC_FAVICON_DARK ||
                '/favicon-dark.png',
        },
        title: config?.title || process.env.NEXT_PUBLIC_SITE_TITLE || name,
        description:
            config?.description ||
            process.env.NEXT_PUBLIC_SITE_DESCRIPTION ||
            'Build Works with AI',
        keywords:
            config?.keywords ||
            (process.env.NEXT_PUBLIC_SITE_KEYWORDS
                ? process.env.NEXT_PUBLIC_SITE_KEYWORDS.split(',').map((k) => k.trim())
                : ['Ever Works', 'Works', 'AI', 'Automation', 'Productivity', 'Workflow']),
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
                'Build Works with AI',
        },
    } as const;
};

// Default site config (for backward compatibility)
export const SITE_CONFIG = getSiteConfig();
