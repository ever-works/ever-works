import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DataManagement } from '@/components/settings/DataManagement';

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations('dashboard.settings');
	return { title: t('tabs.data') };
}

export default async function DataSettingsPage() {
	return <DataManagement />;
}
