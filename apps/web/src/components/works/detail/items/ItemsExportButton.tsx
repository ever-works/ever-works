'use client';

import { useEffect, useState } from 'react';
import { Download, FileText, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils/cn';

interface ItemsExportButtonProps {
    workId: string;
}

/**
 * Export dropdown for the items page (EW-533 Phase 1). Renders when the
 * directory has `settings.export_enabled === true` in its `.works/works.yml`;
 * otherwise renders nothing so the gate is invisible.
 *
 * Clicking a format triggers a same-origin GET to the Next.js proxy route at
 * `/api/works/[id]/export-items?format=...`, which forwards to the NestJS
 * API with the session token from cookies. The proxy passes the upstream
 * `Content-Disposition` through, so the browser handles the file save.
 */
export function ItemsExportButton({ workId }: ItemsExportButtonProps) {
    const [enabled, setEnabled] = useState<boolean | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/works/${workId}/export-items/settings`, { credentials: 'include' })
            .then((response) => response.json())
            .then((data: { export_enabled?: boolean } | null) => {
                if (!cancelled) {
                    setEnabled(!!data?.export_enabled);
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

    const download = (format: 'csv' | 'xlsx') => {
        window.location.href = `/api/works/${workId}/export-items?format=${format}`;
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="secondary"
                    className={cn('inline-flex items-center gap-2', 'text-sm')}
                >
                    <Download className="w-4 h-4" />
                    Export
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => download('csv')}>
                    <FileText className="w-4 h-4 mr-2" />
                    CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => download('xlsx')}>
                    <FileSpreadsheet className="w-4 h-4 mr-2" />
                    Excel (.xlsx)
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
