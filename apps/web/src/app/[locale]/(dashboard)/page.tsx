import { getTranslations } from 'next-intl/server';

export default async function Dashboard() {
    const t = await getTranslations('dashboard');

    return <div>{t('title')}</div>;
}
