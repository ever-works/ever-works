'use client';

import { useCallback, useState } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { NewVirtualComputerDialog } from './NewVirtualComputerDialog';

/**
 * Virtual computers (FL-16, spec FR-1) — what "Add computer ▾ › New virtual
 * computer…" opens: the hub's Computers tab with `?add=virtual`, where this
 * mounts the dialog with "Choose for me" preselected. Closing it drops the
 * query, so a reload does not reopen it (the FL-01 `?add=` behaviour).
 */
export function NewVirtualComputerLauncher() {
    const router = useRouter();
    const pathname = usePathname();
    const [open, setOpen] = useState(true);
    const close = useCallback(() => {
        setOpen(false);
        router.replace(pathname);
    }, [router, pathname]);
    return (
        <NewVirtualComputerDialog open={open} onClose={close} onCreated={() => router.refresh()} />
    );
}
