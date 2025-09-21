import { directoryAPI } from '@/lib/api';
import { GeneratorForm } from '@/components/directories/detail/generator/GeneratorForm';
import { GenerationProgress } from '@/components/directories/detail/generator/GenerationProgress';
import { GenerateStatusType } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryGeneratorPage({ params }: Params) {
    const { id } = await params;

    const res = await directoryAPI.get(id);
    const directory = res.directory;

    // If currently generating, show progress
    if (directory.generateStatus?.status === GenerateStatusType.GENERATING) {
        return <GenerationProgress directory={directory} />;
    }

    return <GeneratorForm directoryId={id} directory={directory} />;
}