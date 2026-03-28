import { cookies } from 'next/headers';
import { getAuthFromCookie } from '@/lib/auth';
import { DashboardLayoutClient } from './layout-client';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const user = await getAuthFromCookie();

    if (!user) {
        return null;
    }

    const cookieStore = await cookies();
    const chatCookie = cookieStore.get('chat-panel-open')?.value;
    const chatPanelOpen = chatCookie === undefined ? true : chatCookie === '1';

    return (
        <DashboardLayoutClient user={user} initialChatOpen={chatPanelOpen}>
            {children}
        </DashboardLayoutClient>
    );
}
