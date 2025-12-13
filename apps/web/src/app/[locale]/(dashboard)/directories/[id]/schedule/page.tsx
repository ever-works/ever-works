import { directoryAPI } from '@/lib/api';
import { DirectoryScheduleCard } from '@/components/directories/detail/schedule/DirectoryScheduleCard';
import { DirectoryScheduleHeader } from '@/components/directories/detail/schedule/DirectoryScheduleHeader';

type Params = { params: Promise<{ id: string }> };

export default async function DirectorySchedulePage({ params }: Params) {
    const { id } = await params;

    const scheduleRes = await directoryAPI.getSchedule(id).catch(() => null);

    return (
        <div className="space-y-6">
            <DirectoryScheduleHeader />

            <DirectoryScheduleCard schedule={scheduleRes?.schedule || null} />
        </div>
    );
}
