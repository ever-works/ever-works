import { GeneratorSubTabs } from '@/components/works/detail/generator/GeneratorSubTabs';

type LayoutParams = {
    params: Promise<{ id: string }>;
    children: React.ReactNode;
};

export default async function GeneratorLayout({ params, children }: LayoutParams) {
    const { id } = await params;

    return (
        <>
            <GeneratorSubTabs workId={id} />
            {children}
        </>
    );
}
