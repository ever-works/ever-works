import { directoryAPI } from '@/lib/api';
import { GeneratorForm } from '@/components/directories/detail/generator/GeneratorForm';
import { GenerationProgress } from '@/components/directories/detail/generator/GenerationProgress';
import { GenerateStatusType } from '@/lib/api/enums';

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryGeneratorPage({ params }: Params) {
    const { id } = await params;

    const [directoryRes, configRes] = await Promise.all([
        directoryAPI.get(id),
        directoryAPI.getConfig(id),
    ]);

    const directory = directoryRes.directory;
    const config = configRes.config;

    // If currently generating, show progress
    if (directory.generateStatus?.status === GenerateStatusType.GENERATING) {
        return <GenerationProgress directory={directory} />;
    }

    return <GeneratorForm directoryId={id} directory={directory} config={config} />;
}
