'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, Loader2, Upload, X } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

interface ItemImportWizardProps {
    workId: string;
    isOpen: boolean;
    onClose: () => void;
}

type WizardStep = 'upload' | 'mapping' | 'preview';

interface ImportRowValidation {
    rowIndex: number;
    valid: boolean;
    errors: string[];
    warnings: string[];
    duplicate?: { slug?: string; source_url?: string };
}

interface ImportValidationResponse {
    headers: string[];
    suggestedMapping: Record<string, string>;
    validationResults: ImportRowValidation[];
    summary: { total: number; valid: number; invalid: number; duplicates: number };
}

/**
 * Canonical importable field names, kept in lockstep with
 * `packages/agent/src/items-generator/column-mapping.ts:ALL_IMPORT_FIELDS`.
 * Inlined client-side because the list is small + stable; revisit when
 * the contract becomes dynamic (custom per-directory fields).
 */
const CANONICAL_FIELDS = [
    'name',
    'description',
    'source_url',
    'category',
    'categories',
    'tags',
    'slug',
    'featured',
    'order',
    'brand',
    'brand_logo_url',
    'images',
] as const;
const SKIP_OPTION = '__skip__';

const ACCEPTED_FILE_RE = /\.(csv|xlsx|xls)$/i;

/**
 * Phase 2 (EW-533) import wizard: Upload → Mapping → Preview. No writes.
 * The Execute step (Phase 3) will replace the "Close" button in Preview
 * with a "Confirm Import" action.
 */
export function ItemImportWizard({ workId, isOpen, onClose }: ItemImportWizardProps) {
    const [step, setStep] = useState<WizardStep>('upload');
    const [file, setFile] = useState<File | null>(null);
    const [mapping, setMapping] = useState<Record<string, string>>({});
    const [validation, setValidation] = useState<ImportValidationResponse | null>(null);
    const [isWorking, setIsWorking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [maxRows, setMaxRows] = useState<number>(500);
    const [dragActive, setDragActive] = useState(false);

    const reset = useCallback(() => {
        setStep('upload');
        setFile(null);
        setMapping({});
        setValidation(null);
        setError(null);
        setIsWorking(false);
        setDragActive(false);
    }, []);

    useEffect(() => {
        if (!isOpen) {
            reset();
            return;
        }
        let cancelled = false;
        fetch(`/api/works/${workId}/import-items/settings`, { credentials: 'include' })
            .then((r) => r.json())
            .then((data: { import_max_rows?: number } | null) => {
                if (!cancelled && typeof data?.import_max_rows === 'number') {
                    setMaxRows(data.import_max_rows);
                }
            })
            .catch(() => {
                // Use default 500.
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen, workId, reset]);

    const runValidate = useCallback(
        async (chosenFile: File, currentMapping: Record<string, string>) => {
            setIsWorking(true);
            setError(null);
            try {
                const formData = new FormData();
                formData.append('file', chosenFile);
                formData.append('mapping', JSON.stringify(stripSkippedFields(currentMapping)));
                const response = await fetch(`/api/works/${workId}/import-items/validate`, {
                    method: 'POST',
                    body: formData,
                    credentials: 'include',
                });
                if (!response.ok) {
                    const detail = await readErrorDetail(response);
                    setError(detail);
                    return null;
                }
                const data = (await response.json()) as ImportValidationResponse;
                setValidation(data);
                setMapping((prev) =>
                    Object.keys(prev).length > 0
                        ? prev
                        : { ...data.suggestedMapping, ...prev },
                );
                return data;
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to validate file');
                return null;
            } finally {
                setIsWorking(false);
            }
        },
        [workId],
    );

    const handleFileSelected = async (chosenFile: File) => {
        if (!ACCEPTED_FILE_RE.test(chosenFile.name)) {
            setError('File must be .csv, .xls, or .xlsx');
            return;
        }
        setFile(chosenFile);
        const result = await runValidate(chosenFile, {});
        if (result) {
            setStep('mapping');
        }
    };

    const handleRevalidateWithMapping = async () => {
        if (!file) return;
        const result = await runValidate(file, mapping);
        if (result) {
            setStep('preview');
        }
    };

    const handleDownloadSample = (format: 'csv' | 'xlsx') => {
        window.location.href = `/api/works/${workId}/import-items/sample?format=${format}`;
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-4xl">
                <DialogHeader>
                    <div className="flex items-start justify-between">
                        <div>
                            <DialogTitle>
                                <span className="text-lg font-semibold text-text dark:text-text-dark">
                                    Import items
                                </span>
                            </DialogTitle>
                            <DialogDescription>
                                Upload a CSV or Excel file. Validation only — no writes happen
                                until you confirm in the next phase.
                            </DialogDescription>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close"
                            className="text-text-muted hover:text-text dark:text-text-muted-dark dark:hover:text-text-dark"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    <WizardSteps current={step} />
                </DialogHeader>

                {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

                {step === 'upload' ? (
                    <UploadStep
                        dragActive={dragActive}
                        setDragActive={setDragActive}
                        isWorking={isWorking}
                        onFileSelected={handleFileSelected}
                        onDownloadSample={handleDownloadSample}
                        maxRows={maxRows}
                    />
                ) : null}

                {step === 'mapping' && validation ? (
                    <MappingStep
                        headers={validation.headers}
                        mapping={mapping}
                        onMappingChange={setMapping}
                    />
                ) : null}

                {step === 'preview' && validation ? <PreviewStep validation={validation} /> : null}

                <DialogFooter>
                    {step === 'upload' ? (
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                    ) : null}
                    {step === 'mapping' ? (
                        <>
                            <Button variant="ghost" onClick={() => setStep('upload')}>
                                Back
                            </Button>
                            <Button
                                onClick={handleRevalidateWithMapping}
                                disabled={isWorking}
                                loading={isWorking}
                            >
                                Continue
                            </Button>
                        </>
                    ) : null}
                    {step === 'preview' ? (
                        <>
                            <Button variant="ghost" onClick={() => setStep('mapping')}>
                                Back
                            </Button>
                            <Button onClick={onClose}>Done</Button>
                        </>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------

function WizardSteps({ current }: { current: WizardStep }) {
    const steps: { id: WizardStep; label: string }[] = [
        { id: 'upload', label: '1. Upload' },
        { id: 'mapping', label: '2. Mapping' },
        { id: 'preview', label: '3. Preview' },
    ];
    const currentIdx = steps.findIndex((s) => s.id === current);
    return (
        <div className="flex items-center gap-2 mt-4 text-xs">
            {steps.map((s, idx) => (
                <div key={s.id} className="flex items-center gap-2">
                    <span
                        className={cn(
                            'inline-flex items-center justify-center w-6 h-6 rounded-full',
                            idx === currentIdx
                                ? 'bg-button-primary text-button-primary-foreground'
                                : idx < currentIdx
                                  ? 'bg-success text-white'
                                  : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark',
                        )}
                    >
                        {idx < currentIdx ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
                    </span>
                    <span
                        className={cn(
                            idx === currentIdx
                                ? 'text-text dark:text-text-dark font-medium'
                                : 'text-text-muted dark:text-text-muted-dark',
                        )}
                    >
                        {s.label.replace(/^\d\.\s*/, '')}
                    </span>
                    {idx < steps.length - 1 ? (
                        <span className="text-text-muted dark:text-text-muted-dark">→</span>
                    ) : null}
                </div>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------

interface UploadStepProps {
    dragActive: boolean;
    setDragActive: (v: boolean) => void;
    isWorking: boolean;
    onFileSelected: (file: File) => void;
    onDownloadSample: (format: 'csv' | 'xlsx') => void;
    maxRows: number;
}

function UploadStep({
    dragActive,
    setDragActive,
    isWorking,
    onFileSelected,
    onDownloadSample,
    maxRows,
}: UploadStepProps) {
    return (
        <div className="space-y-4">
            <div
                onDragEnter={(e) => {
                    e.preventDefault();
                    setDragActive(true);
                }}
                onDragOver={(e) => {
                    e.preventDefault();
                    setDragActive(true);
                }}
                onDragLeave={(e) => {
                    e.preventDefault();
                    setDragActive(false);
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragActive(false);
                    const dropped = e.dataTransfer.files?.[0];
                    if (dropped) onFileSelected(dropped);
                }}
                className={cn(
                    'rounded-lg border-2 border-dashed p-10 text-center',
                    'transition-colors',
                    dragActive
                        ? 'border-button-primary bg-button-primary/5'
                        : 'border-border dark:border-border-dark',
                )}
            >
                {isWorking ? (
                    <div className="flex flex-col items-center gap-2 text-text-muted dark:text-text-muted-dark">
                        <Loader2 className="w-8 h-8 animate-spin" />
                        <span>Parsing + validating…</span>
                    </div>
                ) : (
                    <>
                        <Upload className="w-10 h-10 mx-auto text-text-muted dark:text-text-muted-dark mb-3" />
                        <p className="text-sm text-text dark:text-text-dark mb-1">
                            Drag a CSV or Excel file here
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mb-4">
                            or
                        </p>
                        <label className="inline-block">
                            <input
                                type="file"
                                accept=".csv,.xls,.xlsx"
                                className="sr-only"
                                onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    if (f) onFileSelected(f);
                                    // Reset so re-selecting the same file fires `change`.
                                    e.target.value = '';
                                }}
                            />
                            <span className="inline-flex items-center gap-2 px-4 py-2 rounded-sm bg-button-primary text-button-primary-foreground cursor-pointer text-sm hover:bg-button-primary-hover">
                                <FileText className="w-4 h-4" />
                                Browse file
                            </span>
                        </label>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-4">
                            Max {maxRows} rows per upload. CSV / XLSX / XLS only.
                        </p>
                    </>
                )}
            </div>
            <div className="flex items-center justify-between text-xs text-text-muted dark:text-text-muted-dark">
                <span>Need a starting point?</span>
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        className="underline hover:no-underline"
                        onClick={() => onDownloadSample('csv')}
                    >
                        Download sample CSV
                    </button>
                    <button
                        type="button"
                        className="underline hover:no-underline"
                        onClick={() => onDownloadSample('xlsx')}
                    >
                        Download sample Excel
                    </button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------

interface MappingStepProps {
    headers: string[];
    mapping: Record<string, string>;
    onMappingChange: (next: Record<string, string>) => void;
}

function MappingStep({ headers, mapping, onMappingChange }: MappingStepProps) {
    const usedTargets = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const value of Object.values(mapping)) {
            if (value && value !== SKIP_OPTION) {
                counts[value] = (counts[value] ?? 0) + 1;
            }
        }
        return counts;
    }, [mapping]);

    return (
        <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                Map each column in your file to a directory item field. Required:{' '}
                <code>name</code>, <code>description</code>, <code>source_url</code>, and{' '}
                <code>category</code> (or <code>categories</code>).
            </p>
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left border-b border-border dark:border-border-dark">
                        <th className="py-2 font-medium text-text-muted dark:text-text-muted-dark">
                            File column
                        </th>
                        <th className="py-2 font-medium text-text-muted dark:text-text-muted-dark">
                            Item field
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {headers.map((header) => {
                        const current = mapping[header] ?? SKIP_OPTION;
                        const isDuplicate =
                            current !== SKIP_OPTION && (usedTargets[current] ?? 0) > 1;
                        return (
                            <tr
                                key={header}
                                className="border-b border-border/50 dark:border-border-dark/50"
                            >
                                <td className="py-2 font-mono text-xs">{header}</td>
                                <td className="py-2">
                                    <select
                                        value={current}
                                        onChange={(e) =>
                                            onMappingChange({
                                                ...mapping,
                                                [header]: e.target.value,
                                            })
                                        }
                                        className={cn(
                                            'rounded-sm border bg-surface dark:bg-surface-dark px-2 py-1 text-sm',
                                            isDuplicate
                                                ? 'border-danger'
                                                : 'border-border dark:border-border-dark',
                                        )}
                                    >
                                        <option value={SKIP_OPTION}>(skip)</option>
                                        {CANONICAL_FIELDS.map((field) => (
                                            <option key={field} value={field}>
                                                {field}
                                            </option>
                                        ))}
                                    </select>
                                    {isDuplicate ? (
                                        <span className="ml-2 text-xs text-danger">
                                            Already mapped
                                        </span>
                                    ) : null}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

// ---------------------------------------------------------------------------

function PreviewStep({ validation }: { validation: ImportValidationResponse }) {
    const { summary, validationResults } = validation;
    return (
        <div className="space-y-4 max-h-[55vh] overflow-y-auto">
            <div className="grid grid-cols-4 gap-3 text-center text-sm">
                <SummaryCard label="Total rows" value={summary.total} />
                <SummaryCard label="Valid" value={summary.valid} tone="success" />
                <SummaryCard label="Invalid" value={summary.invalid} tone="danger" />
                <SummaryCard label="Duplicates" value={summary.duplicates} tone="warning" />
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                Phase 2 (dry-run) — nothing is written. The Confirm Import step lands in Phase 3.
            </p>
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left border-b border-border dark:border-border-dark">
                        <th className="py-2 w-12">Row</th>
                        <th className="py-2 w-24">Status</th>
                        <th className="py-2">Errors / warnings</th>
                    </tr>
                </thead>
                <tbody>
                    {validationResults.slice(0, 200).map((row) => (
                        <tr
                            key={row.rowIndex}
                            className="border-b border-border/50 dark:border-border-dark/50 align-top"
                        >
                            <td className="py-2 font-mono">{row.rowIndex + 1}</td>
                            <td className="py-2">
                                <RowStatusBadge row={row} />
                            </td>
                            <td className="py-2">
                                {row.errors.length === 0 && row.warnings.length === 0 ? (
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        —
                                    </span>
                                ) : (
                                    <ul className="space-y-0.5">
                                        {row.errors.map((e, i) => (
                                            <li
                                                key={`e-${i}`}
                                                className="text-danger text-xs flex items-start gap-1"
                                            >
                                                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                                                {e}
                                            </li>
                                        ))}
                                        {row.warnings.map((w, i) => (
                                            <li
                                                key={`w-${i}`}
                                                className="text-warning text-xs flex items-start gap-1"
                                            >
                                                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                                                {w}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {row.duplicate ? (
                                    <p className="text-xs text-warning mt-1">
                                        Duplicate of existing item
                                        {row.duplicate.slug ? ` (slug: ${row.duplicate.slug})` : ''}
                                        {row.duplicate.source_url
                                            ? ` (url: ${row.duplicate.source_url})`
                                            : ''}
                                    </p>
                                ) : null}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {validationResults.length > 200 ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark text-center">
                    Showing the first 200 rows of {validationResults.length}.
                </p>
            ) : null}
        </div>
    );
}

function RowStatusBadge({ row }: { row: ImportRowValidation }) {
    if (!row.valid) {
        return (
            <span className="inline-flex items-center gap-1 text-xs text-danger">
                <AlertCircle className="w-3 h-3" /> Invalid
            </span>
        );
    }
    if (row.duplicate) {
        return (
            <span className="inline-flex items-center gap-1 text-xs text-warning">
                <AlertCircle className="w-3 h-3" /> Duplicate
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="w-3 h-3" /> Valid
        </span>
    );
}

// ---------------------------------------------------------------------------

function SummaryCard({
    label,
    value,
    tone,
}: {
    label: string;
    value: number;
    tone?: 'success' | 'danger' | 'warning';
}) {
    return (
        <div
            className={cn(
                'rounded-md border px-3 py-2',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div
                className={cn(
                    'text-2xl font-semibold',
                    tone === 'success' && 'text-success',
                    tone === 'danger' && 'text-danger',
                    tone === 'warning' && 'text-warning',
                    !tone && 'text-text dark:text-text-dark',
                )}
            >
                {value}
            </div>
            <div className="text-xs text-text-muted dark:text-text-muted-dark">{label}</div>
        </div>
    );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    return (
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="flex-1">{message}</span>
            <button type="button" onClick={onDismiss} aria-label="Dismiss">
                <X className="w-4 h-4" />
            </button>
        </div>
    );
}

function stripSkippedFields(mapping: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(mapping)) {
        if (value && value !== SKIP_OPTION) {
            out[key] = value;
        }
    }
    return out;
}

async function readErrorDetail(response: Response): Promise<string> {
    try {
        const data = await response.json();
        if (data && typeof data === 'object' && 'message' in data) {
            return String((data as { message: unknown }).message);
        }
    } catch {
        // fall through
    }
    return `Validation request failed (${response.status})`;
}
