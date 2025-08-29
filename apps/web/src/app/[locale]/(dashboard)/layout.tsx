import { getAuthFromCookie } from '@/lib/auth';
import { DashboardLayoutClient } from './layout-client';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const user = await getAuthFromCookie();

    if (!user) {
        // This shouldn't happen as middleware should redirect
        // but keeping as a safety check
        return null;
    }

    return <DashboardLayoutClient user={user}>{children}</DashboardLayoutClient>;
}
