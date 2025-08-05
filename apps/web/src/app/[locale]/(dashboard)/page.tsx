import { getAuthUser } from '@/lib/auth';
import { getTranslations } from 'next-intl/server';

export default async function Dashboard() {
    const user = await getAuthUser();
    const t = await getTranslations('dashboard');

    console.log(user);

    return (
        <div>
            {t('title')}

            {JSON.stringify(user)}
        </div>
    );
}
