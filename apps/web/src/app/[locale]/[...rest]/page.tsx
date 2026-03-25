import { useTranslations } from 'next-intl';
import { NotFoundContent } from '@/components/not-found-content';

// Prevent search engines from indexing this 404 catch-all page
export const metadata = {
    robots: 'noindex',
};

export default function NotFoundPage() {
    const t = useTranslations('errors.notFound');

    return (
        <NotFoundContent
            title={t('title')}
            description={t('description')}
            backHomeLabel={t('backHome')}
            goBackLabel={t('goBack')}
        />
    );
}
