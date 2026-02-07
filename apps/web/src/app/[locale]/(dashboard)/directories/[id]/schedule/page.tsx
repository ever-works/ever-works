import { directoryAPI, itemsGeneratorAPI } from '@/lib/api';
import { DirectoryScheduleCard } from '@/components/directories/detail/schedule/DirectoryScheduleCard';
import { DirectoryScheduleHeader } from '@/components/directories/detail/schedule/DirectoryScheduleHeader';
import { canManageSchedule } from '@/lib/permissions';
import { notFound } from 'next/navigation';

type Params = { params: Promise<{ id: string }> };

export default async function DirectorySchedulePage({ params }: Params) {
    const { id } = await params;

    const [directoryRes, scheduleRes, formSchema] = await Promise.all([
        directoryAPI.get(id),
        directoryAPI.getSchedule(id).catch(() => null),
        itemsGeneratorAPI.getFormSchema(id).catch(() => null),
    ]);

    const directory = directoryRes.directory;

    // Server-side permission check: only editors+ can manage schedule
    if (!canManageSchedule(directory.userRole)) {
        notFound();
    }

    const pipelineProviders = formSchema?.providers?.fullPipeline ?? [];

    return (
        <div className="space-y-6">
            <DirectoryScheduleHeader />

            <DirectoryScheduleCard
                schedule={scheduleRes?.schedule || null}
                pipelineProviders={pipelineProviders}
            />
        </div>
    );
}
