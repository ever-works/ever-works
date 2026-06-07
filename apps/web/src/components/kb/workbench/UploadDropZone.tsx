'use client';

import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { KbDocumentClass } from '@ever-works/contracts';

/**
 * EW-641 slice C — drag-and-drop drop zone wrapper for the workbench tree
 * panel.
 *
 * Wraps `KbTreePanel`'s tree node tree with native HTML5 drag-and-drop
 * affordances. When a user drags an OS file over the tree, the wrapper
 * lights up to indicate the drop target. On drop, `onDrop(files,
 * targetClass)` fires — the parent route handler then opens the
 * `UploadClassificationModal` and runs the upload coordinator.
 *
 * The drop-target *class* is inferred from the closest ancestor element
 * carrying `data-kb-class="<KbDocumentClass>"`. `KbTreePanel`'s group
 * containers already render such an attribute on their `[data-testid=
 * "kb-workbench-group-<cls>"]` div (see the data-attribute we add in
 * slice C). When the drop happens outside any group (or the tree's empty
 * state), the zone falls back to `defaultClass` (typically `'freeform'`).
 *
 * Slice E will swap the inferred-target affordance for a more elaborate
 * tree drop-target highlight (per-node hover ring, expand-on-hover after
 * 600 ms, etc.); this slice keeps things simple.
 */

export interface UploadDropZoneProps {
    /** Children — typically the existing `KbTreePanel` content. */
    readonly children: ReactNode;
    /**
     * Fallback target class when the drop lands outside any class group
     * (or on the empty tree). Defaults to `'freeform'`.
     */
    readonly defaultClass?: KbDocumentClass;
    /**
     * Fired when the user drops one-or-more OS files onto the tree.
     * `targetClass` is the inferred drop-target (closest ancestor's
     * `data-kb-class`, or `defaultClass`).
     */
    readonly onDrop: (files: File[], targetClass: KbDocumentClass) => void;
    /** Optional className passthrough for layout integration. */
    readonly className?: string;
}

/**
 * Resolve the drop-target class by walking up the DOM from `target`
 * looking for a `data-kb-class` attribute. Returns `null` when none is
 * found — the caller falls back to `defaultClass`.
 */
function resolveTargetClass(target: EventTarget | null): KbDocumentClass | null {
    if (!(target instanceof Element)) return null;
    const hit = target.closest('[data-kb-class]');
    if (!hit) return null;
    const value = hit.getAttribute('data-kb-class');
    return (value as KbDocumentClass) ?? null;
}

export function UploadDropZone({
    children,
    defaultClass = 'freeform' as KbDocumentClass,
    onDrop,
    className,
}: UploadDropZoneProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench.upload');
    const [active, setActive] = useState(false);
    const [hoverClass, setHoverClass] = useState<KbDocumentClass | null>(null);
    // `dragenter` and `dragleave` fire for every descendant traversal. We
    // count net enters so the wrapper stays "active" until the user leaves
    // for real.
    const dragDepth = useRef(0);

    const isFileDrag = useCallback((ev: DragEvent<HTMLDivElement>): boolean => {
        if (!ev.dataTransfer) return false;
        const types = ev.dataTransfer.types;
        if (!types) return false;
        for (let i = 0; i < types.length; i++) {
            if (types[i] === 'Files') return true;
        }
        return false;
    }, []);

    const handleDragEnter = useCallback(
        (ev: DragEvent<HTMLDivElement>) => {
            if (!isFileDrag(ev)) return;
            ev.preventDefault();
            dragDepth.current += 1;
            setActive(true);
        },
        [isFileDrag],
    );

    const handleDragOver = useCallback(
        (ev: DragEvent<HTMLDivElement>) => {
            if (!isFileDrag(ev)) return;
            ev.preventDefault();
            if (ev.dataTransfer) {
                ev.dataTransfer.dropEffect = 'copy';
            }
            const cls = resolveTargetClass(ev.target);
            setHoverClass(cls);
        },
        [isFileDrag],
    );

    const handleDragLeave = useCallback((ev: DragEvent<HTMLDivElement>) => {
        ev.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
            setActive(false);
            setHoverClass(null);
        }
    }, []);

    const handleDrop = useCallback(
        (ev: DragEvent<HTMLDivElement>) => {
            if (!isFileDrag(ev)) return;
            ev.preventDefault();
            dragDepth.current = 0;
            setActive(false);
            const cls = resolveTargetClass(ev.target) ?? defaultClass;
            setHoverClass(null);
            const dt = ev.dataTransfer;
            const files: File[] = [];
            if (dt?.files && dt.files.length > 0) {
                for (let i = 0; i < dt.files.length; i++) {
                    const file = dt.files.item(i);
                    if (file) files.push(file);
                }
            }
            if (files.length === 0) return;
            onDrop(files, cls);
        },
        [defaultClass, isFileDrag, onDrop],
    );

    return (
        <div
            data-testid="kb-workbench-dropzone"
            data-active={active ? 'true' : 'false'}
            data-hover-class={hoverClass ?? ''}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn('relative h-full', className)}
        >
            {children}
            {active ? (
                <div
                    data-testid="kb-workbench-dropzone-overlay"
                    aria-hidden="true"
                    className={cn(
                        'pointer-events-none absolute inset-0 z-10 flex items-center justify-center',
                        'rounded-md border-2 border-dashed border-primary/70',
                        'bg-primary/5 backdrop-blur-[1px]',
                        'dark:border-primary/60 dark:bg-primary/10',
                    )}
                >
                    <p className="rounded bg-surface/90 px-3 py-1.5 text-xs font-medium text-text shadow dark:bg-surface-dark/90 dark:text-text-dark">
                        {t('dropPrompt')}
                    </p>
                </div>
            ) : null}
        </div>
    );
}
