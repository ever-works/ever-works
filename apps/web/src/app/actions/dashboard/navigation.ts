'use server';

import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { ROUTES } from '@/lib/constants';

export async function redirectToDirectories() {
    const locale = await getLocale();
    redirect({ locale, href: ROUTES.DASHBOARD_DIRECTORIES });
}

export async function redirectToNewDirectory() {
    const locale = await getLocale();
    redirect({ locale, href: ROUTES.DASHBOARD_DIRECTORIES_NEW });
}

export async function redirectToDashboard() {
    const locale = await getLocale();
    redirect({ locale, href: ROUTES.DASHBOARD });
}

export async function redirectToSettings() {
    const locale = await getLocale();
    redirect({ locale, href: ROUTES.DASHBOARD_SETTINGS });
}

export async function redirectToAnalytics() {
    const locale = await getLocale();
    redirect({ locale, href: ROUTES.DASHBOARD_ANALYTICS });
}

export async function redirectToNotifications() {
    const locale = await getLocale();
    redirect({ locale, href: ROUTES.DASHBOARD_NOTIFICATIONS });
}
