import { getAuthFromCookie } from '@/lib/auth';
import DashboardClient from './dashboard-client';
import { getDirectories } from '@/app/actions/dashboard/directories';
import { GET_DIRECTORY_LIST_LIMIT } from '@/lib/constants';

export default async function Dashboard() {
    const user = await getAuthFromCookie();

    const directoriesResponse = await getDirectories({ limit: GET_DIRECTORY_LIST_LIMIT });

    return (
        <DashboardClient
            user={user!}
            initialDirectories={directoriesResponse.directories}
            totalDirectories={directoriesResponse.total}
        />
    );
}
