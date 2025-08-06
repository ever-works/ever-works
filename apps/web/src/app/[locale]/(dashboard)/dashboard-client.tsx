'use client';

import { logout } from '@/app/actions/auth';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { Suspense, useTransition } from 'react';
import DashboardToasts from './dashboard-toasts';

export default function DashboardClient({ user }: { user: AuthUser }) {
    const t = useTranslations('dashboard');
    const [isPending, startTransition] = useTransition();

    const handleLogout = async () => {
        startTransition(async () => {
            await logout();
        });
    };

    return (
        <>
            <Suspense fallback={null}>
                <DashboardToasts />
            </Suspense>

            <div className="max-w-md mx-auto">
                <h3 className="text-2xl font-bold text-text mb-4"> {t('title')}</h3>

                <ul>
                    <li> Email : {user.email}</li>
                    <li> Username : {user.username}</li>
                    <li> Provider : {user.provider}</li>
                    <li> EmailVerified : {JSON.stringify(user.emailVerified)}</li>
                    <li> isActive : {JSON.stringify(user.isActive)}</li>
                    <li> Avatar : {user.avatar}</li>
                </ul>

                <br />

                <button
                    onClick={handleLogout}
                    disabled={isPending}
                    className={cn(
                        'px-6 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                >
                    Logout
                </button>
            </div>
        </>
    );
}
