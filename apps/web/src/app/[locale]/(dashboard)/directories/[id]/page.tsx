import { Directory, directoryAPI } from '@/lib/api';
import { notFound } from 'next/navigation';

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryPage({ params }: Params) {
    const { id } = await params;
    let directory: Directory;

    try {
        const res = await directoryAPI.get(id);
        directory = res.directory;
    } catch (error) {
        console.error('Failed to fetch directory:', error);
        notFound();
    }

    return <div>Directory Page {directory.name}</div>;
}
