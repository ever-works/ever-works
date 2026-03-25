import { useTranslations } from 'next-intl';
import { NotFoundContent } from '@/components/not-found-content';

export default function NotFound() {
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
