import { directoryAPI } from '@/lib/api';
import { DirectoryStatusCard } from '@/components/directories/detail/DirectoryStatusCard';
import { DirectoryInfo } from '@/components/directories/detail/overview/DirectoryInfo';
import { DirectoryStats } from '@/components/directories/detail/overview/DirectoryStats';
import { DirectoryConfig } from '@/components/directories/detail/overview/DirectoryConfig';
import { GenerateStatusType } from '@/lib/api/enums';

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryOverviewPage({ params }: Params) {
    const { id } = await params;

    const [directoryRes, configRes] = await Promise.all([
        directoryAPI.get(id),
        directoryAPI.getConfig(id).catch(() => ({ config: null })),
    ]);

    const directory = directoryRes.directory;
    const config = configRes.config;

    const isGenerating =
        !directory.generateStatus?.status ||
        directory.generateStatus?.status === GenerateStatusType.GENERATING;

    return (
        <div className="space-y-6">
            {/* Only show status card when generating */}
            {isGenerating && <DirectoryStatusCard directory={directory} />}
            <DirectoryStats directory={directory} />

            {/* Directory Info and Config side by side */}
            <div className="grid lg:grid-cols-2 gap-6">
                <DirectoryInfo directory={directory} />
                {config && <DirectoryConfig config={config} />}
            </div>
        </div>
    );
}
