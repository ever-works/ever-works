import { Directory, directoryAPI } from '@/lib/api';
import { notFound } from 'next/navigation';
import { DirectoryLayoutClient } from '@/components/directories/detail/DirectoryLayoutClient';

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

    return <DirectoryLayoutClient directory={directory}>{children}</DirectoryLayoutClient>;
}
