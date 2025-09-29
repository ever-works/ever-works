import { directoryAPI } from '@/lib/api';
import { SettingsForm } from '@/components/directories/detail/settings/SettingsForm';
import { getAuthFromCookie } from '@/lib/auth';

type Params = { params: Promise<{ id: string }> };

export default async function DirectorySettingsPage({ params }: Params) {
    const { id } = await params;

    const user = await getAuthFromCookie();
    const res = await directoryAPI.get(id);
    const directory = res.directory;

    return (
        <div className="max-w-4xl">
            <SettingsForm directory={directory} user={user!} />
        </div>
    );
}
