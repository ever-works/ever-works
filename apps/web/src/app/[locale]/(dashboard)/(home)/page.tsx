import { getAuthUser } from '@/lib/auth';
import DashboardClient from './dashboard-client';
import { getDirectories } from '@/app/actions/dashboard/directories';

export default async function Dashboard() {
    const user = await getAuthUser();
    
    // Fetch the first 5 directories for the dashboard
    const directoriesResponse = await getDirectories({ limit: 5 });

    return (
        <DashboardClient 
            user={user!} 
            initialDirectories={directoriesResponse.directories}
            totalDirectories={directoriesResponse.total}
        />
    );
}
