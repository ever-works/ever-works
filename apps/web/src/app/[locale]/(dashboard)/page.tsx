import { getAuthUser } from '@/lib/auth';
import DashboardClient from './dashboard-client';

export default async function Dashboard() {
    const user = await getAuthUser();

    return <DashboardClient user={user!} />;
}
