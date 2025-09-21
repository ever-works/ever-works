import { Directory, directoryAPI } from '@/lib/api';
import { DirectoryStatusCard } from '@/components/directories/detail/DirectoryStatusCard';
import { DirectoryInfo } from '@/components/directories/detail/overview/DirectoryInfo';
import { DirectoryStats } from '@/components/directories/detail/overview/DirectoryStats';

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryOverviewPage({ params }: Params) {
    const { id } = await params;

    const res = await directoryAPI.get(id);
    const directory = res.directory;

    return (
        <div className="space-y-6">
            <DirectoryStatusCard directory={directory} />
            <DirectoryStats directory={directory} />
            <DirectoryInfo directory={directory} />
        </div>
    );
}
