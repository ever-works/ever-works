'use client';

import { useEffect, useState } from 'react';
import { Download, FileText, FileSpreadsheet, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils/cn';
import { downloadFromUrl } from './downloadFromUrl';

interface ItemsExportButtonProps {
    workId: string;
}

type DownloadFormat = 'csv' | 'xlsx';

/**
 * Export dropdown for the items page (EW-533 Phase 1). Renders when the
 * directory has `settings.export_enabled === true` in its `.works/works.yml`;
 * otherwise renders nothing so the gate is invisible.
 *
 * The actual download is run as `fetch` + Blob (not `window.location.href`)
 * so we can show a spinner while the server clones/serialises, disable the
 * menu items while a download is in flight, and surface a toast on error.
 */
export function ItemsExportButton({ workId }: ItemsExportButtonProps) {
    const [enabled, setEnabled] = useState<boolean | null>(null);
    const [downloading, setDownloading] = useState<DownloadFormat | null>(null);

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

    const handleDownload = async (format: DownloadFormat) => {
        if (downloading) {
            return;
        }
        setDownloading(format);
        try {
            await downloadFromUrl(`/api/works/${workId}/export-items?format=${format}`);
        } catch (error) {
            toast.error(
                error instanceof Error ? `Export failed: ${error.message}` : 'Export failed',
            );
        } finally {
            setDownloading(null);
        }
    };

    const isBusy = downloading !== null;

    // The shared `DropdownMenu` wrapper has `w-full` on its root element,
    // which makes it expand to fill flex parents and squeeze sibling buttons
    // (Add Item was wrapping to two lines). Wrap in an inline-flex shim so
    // the dropdown's width stays intrinsic.
    return (
        <span className="inline-flex">
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="secondary"
                        disabled={isBusy}
                        className={cn(
                            'inline-flex items-center gap-2 whitespace-nowrap',
                            'text-sm',
                        )}
                    >
                        {isBusy ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Download className="w-4 h-4" />
                        )}
                        {isBusy ? 'Exporting…' : 'Export'}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleDownload('csv')} disabled={isBusy}>
                        {downloading === 'csv' ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                            <FileText className="w-4 h-4 mr-2" />
                        )}
                        {downloading === 'csv' ? 'Downloading CSV…' : 'CSV'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownload('xlsx')} disabled={isBusy}>
                        {downloading === 'xlsx' ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                            <FileSpreadsheet className="w-4 h-4 mr-2" />
                        )}
                        {downloading === 'xlsx' ? 'Downloading Excel…' : 'Excel (.xlsx)'}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}
