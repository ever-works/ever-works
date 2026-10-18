import { getTranslations } from 'next-intl/server';
import { ArrowLeft, ServerOff } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * Fleet hub (FL-01, spec U10, FR-30) — a computer that is not there: removed
 * from Fleet while its page was open, never enrolled, or not shared with the
 * caller. One message for all three, so the page never confirms that a
 * computer the caller may not see exists.
 */
export default async function FleetComputerNotFound() {
    const t = await getTranslations('fleet.computer.notFound');
    return (
        <div
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-10 flex flex-col items-center text-center gap-3"
            data-testid="fleet-computer-not-found"
        >
            <ServerOff
                className="w-6 h-6 text-text-muted dark:text-text-muted-dark"
                aria-hidden="true"
            />
            <h1 className="text-base font-semibold text-text dark:text-text-dark">{t('title')}</h1>
            <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-md">
                {t('body')}
            </p>
            <Link
                href={ROUTES.DASHBOARD_FLEET}
                className="inline-flex items-center gap-1 text-sm font-medium text-info hover:underline"
            >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                {t('back')}
            </Link>
        </div>
    );
}
