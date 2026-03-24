import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ROUTES } from '@/lib/constants';

export default function NotFound() {
    const t = useTranslations('errors.notFound');

    return (
        <div className="flex min-h-screen items-center justify-center bg-background dark:bg-background-dark px-4">
            <div className="text-center max-w-md">
                <p className="text-6xl font-bold text-primary mb-4">404</p>
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h1>
                <p className="text-text-muted dark:text-text-muted-dark mb-8">{t('description')}</p>
                <Link
                    href={ROUTES.DASHBOARD}
                    className="inline-flex items-center justify-center px-6 py-2.5 rounded-lg font-medium transition-colors bg-primary text-white hover:bg-primary-hover"
                >
                    {t('backHome')}
                </Link>
            </div>
        </div>
    );
}
