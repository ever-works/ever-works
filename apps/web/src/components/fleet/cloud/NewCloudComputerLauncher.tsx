'use client';

import { useCallback, useState } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { NewCloudComputerDialog } from './NewCloudComputerDialog';

/**
 * Cloud computers (FL-17, spec §1) — what "Add computer ▾ › New cloud
 * computer…" opens: the hub's Computers tab with `?add=cloud`, where this
 * mounts the dialog. Closing it drops the query, so a reload does not reopen
 * it (the FL-01 `?add=` behaviour); a create refreshes the list so the new
 * row appears with its phase (spec S1).
 */
export function NewCloudComputerLauncher() {
    const router = useRouter();
    const pathname = usePathname();
    const [open, setOpen] = useState(true);
    const close = useCallback(() => {
        setOpen(false);
        router.replace(pathname);
    }, [router, pathname]);
    return <NewCloudComputerDialog open={open} onClose={close} onCreated={() => router.refresh()} />;
}
