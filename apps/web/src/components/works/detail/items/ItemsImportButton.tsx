'use client';

import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { ItemImportWizard } from './ItemImportWizard';

interface ItemsImportButtonProps {
    workId: string;
}

/**
 * Import button + wizard launcher for the items page (EW-533 Phase 2).
 * Renders nothing when the directory has `settings.import_enabled !== true`,
 * so the gate is invisible until a directory admin opts in via the
 * "Item Import & Export" section under Settings.
 */
export function ItemsImportButton({ workId }: ItemsImportButtonProps) {
    const [enabled, setEnabled] = useState<boolean | null>(null);
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/works/${workId}/import-items/settings`, { credentials: 'include' })
            .then((response) => response.json())
            .then((data: { import_enabled?: boolean } | null) => {
                if (!cancelled) {
                    setEnabled(!!data?.import_enabled);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setEnabled(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [workId]);

    if (enabled !== true) {
        return null;
    }

    return (
        <>
            <Button
                variant="secondary"
                onClick={() => setIsOpen(true)}
                className={cn('inline-flex items-center gap-2', 'text-sm')}
            >
                <Upload className="w-4 h-4" />
                Import
            </Button>
            <ItemImportWizard
                workId={workId}
                isOpen={isOpen}
                onClose={() => setIsOpen(false)}
            />
        </>
    );
}
