import { Directory, directoryAPI } from '@/lib/api';
import { notFound } from 'next/navigation';
import { DirectoryHeader } from '@/components/directories/detail/DirectoryHeader';
import { DirectoryTabs } from '@/components/directories/detail/DirectoryTabs';

type LayoutParams = {
    params: Promise<{ id: string }>;
    children: React.ReactNode;
};

export default async function DirectoryLayout({ params, children }: LayoutParams) {
    const { id } = await params;
    let directory: Directory;

    try {
        const res = await directoryAPI.get(id);
        directory = res.directory;
    } catch (error) {
        console.error('Failed to fetch directory:', error);
        notFound();
    }

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
            <DirectoryHeader directory={directory} />
            <DirectoryTabs directoryId={directory.id} />
            <div className="mt-6">
                {children}
            </div>
        </div>
    );
}