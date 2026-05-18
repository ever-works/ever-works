import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { ROUTES } from '@/lib/constants';

export default async function ProfileRedirect() {
    redirect({ locale: await getLocale(), href: ROUTES.DASHBOARD_SETTINGS });
}
