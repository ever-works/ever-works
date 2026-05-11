import { SettingsSubTabs } from '@/components/works/detail/settings/SettingsSubTabs';

type LayoutParams = {
    params: Promise<{ id: string }>;
    children: React.ReactNode;
};

export default async function SettingsLayout({ params, children }: LayoutParams) {
    const { id } = await params;

    return (
        <>
            <SettingsSubTabs workId={id} />
            {children}
        </>
    );
}
