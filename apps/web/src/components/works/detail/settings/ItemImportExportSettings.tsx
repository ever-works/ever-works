'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
} from '@/components/ui/accordion';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { getWebsiteSettings, updateWebsiteSettings } from '@/app/actions/dashboard/works';

interface ItemImportExportSettingsProps {
    workId: string;
}

interface FormState {
    export_enabled: boolean;
    import_enabled: boolean;
    import_max_rows: number;
}

const DEFAULT_FORM: FormState = {
    export_enabled: false,
    import_enabled: false,
    import_max_rows: 500,
};

/**
 * Per-directory toggles for the CSV/Excel item import + export feature
 * (EW-533). Persisted under `settings.*` in `.works/works.yml` via the
 * existing `updateWebsiteSettings` action — only the three relevant keys
 * are sent, so the deep-merge on the server preserves every other setting.
 */
export function ItemImportExportSettings({ workId }: ItemImportExportSettingsProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [formData, setFormData] = useState<FormState>(DEFAULT_FORM);

    useEffect(() => {
        if (!isExpanded || hasLoaded) {
            return;
        }
        let cancelled = false;
        setIsLoading(true);
        getWebsiteSettings(workId)
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if (result.success && result.data) {
                    const settings = result.data.settings ?? {};
                    setFormData({
                        export_enabled: settings.export_enabled ?? false,
                        import_enabled: settings.import_enabled ?? false,
                        import_max_rows: settings.import_max_rows ?? 500,
                    });
                    setHasLoaded(true);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    toast.error('Failed to load item import/export settings');
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setIsLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [isExpanded, hasLoaded, workId]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const result = await updateWebsiteSettings(workId, {
                export_enabled: formData.export_enabled,
                import_enabled: formData.import_enabled,
                import_max_rows: formData.import_max_rows,
            });
            if (result.success) {
                toast.success('Item import/export settings saved');
            } else {
                toast.error(result.error || 'Failed to save settings');
            }
        } catch {
            toast.error('Failed to save settings');
        } finally {
            setIsSaving(false);
        }
    };

    const handleAccordionChange = (value: string) => {
        setIsExpanded(value === 'item-import-export');
    };

    return (
        <Accordion type="single" collapsible onValueChange={handleAccordionChange}>
            <AccordionItem
                value="item-import-export"
                className={cn(
                    'rounded-lg border overflow-hidden',
                    'bg-card dark:bg-card-primary-dark/30',
                    'border-card-border dark:border-border-secondary-dark',
                )}
            >
                <AccordionTrigger className="px-5 py-3.5 hover:no-underline hover:bg-surface/50 dark:hover:bg-surface-dark/50">
                    <div className="text-left">
                        <span className="text-sm font-semibold text-text dark:text-text-dark">
                            Item Import &amp; Export
                        </span>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 font-normal">
                            Bulk CSV / Excel import and export for directory items.
                        </p>
                    </div>
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-4 pt-2">
                    {isLoading ? (
                        <div className="flex justify-center py-12">
                            <Loader2 className="animate-spin h-8 w-8 text-primary" />
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                Both flows are off by default. Enable per directory to expose the
                                Export dropdown on the items page and the bulk-import wizard.
                            </p>
                            <div className="grid grid-cols-1 @md/main:grid-cols-2 gap-4">
                                <Switch
                                    checked={formData.export_enabled}
                                    onChange={(checked) =>
                                        setFormData((prev) => ({
                                            ...prev,
                                            export_enabled: checked,
                                        }))
                                    }
                                    label="Enable item export"
                                />
                                <Switch
                                    checked={formData.import_enabled}
                                    onChange={(checked) =>
                                        setFormData((prev) => ({
                                            ...prev,
                                            import_enabled: checked,
                                        }))
                                    }
                                    label="Enable item import"
                                />
                            </div>
                            <div className="grid grid-cols-1 @md/main:grid-cols-2 gap-4 pt-3 border-t border-card-border dark:border-border-secondary-dark">
                                <Input
                                    type="number"
                                    label="Max rows per import upload"
                                    value={String(formData.import_max_rows)}
                                    onChange={(e) => {
                                        const parsed = Number.parseInt(e.target.value, 10);
                                        setFormData((prev) => ({
                                            ...prev,
                                            import_max_rows:
                                                Number.isFinite(parsed) && parsed > 0
                                                    ? parsed
                                                    : 500,
                                        }));
                                    }}
                                    min={1}
                                    max={2000}
                                    helperText="Hard ceiling is 2000. Default is 500. Files above the limit are rejected before any write."
                                    variant="form"
                                />
                            </div>
                            <div className="flex justify-end pt-2">
                                <Button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={isSaving}
                                    loading={isSaving}
                                    className="text-sm"
                                >
                                    Save Settings
                                </Button>
                            </div>
                        </div>
                    )}
                </AccordionContent>
            </AccordionItem>
        </Accordion>
    );
}
