'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    Bot,
    Briefcase,
    Building2,
    Maximize2,
    PenLine,
    Rocket,
    Shield,
    Sparkles,
    TrendingUp,
    User,
    Users,
    Wrench,
    ZoomIn,
    ZoomOut,
    type LucideIcon,
} from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { OrgChartPayload } from '@/lib/api/teams';
import { buildOrgTree, type OrgTreeNode } from './build-org-tree';

/**
 * Teams & Prebuilt Companies — Org Chart renderer
 * (`docs/specs/features/teams-and-companies/spec.md` §5).
 *
 * Hand-rolled tidy tree (no chart library, per spec "no new dependency"):
 * a pure recursive subtree-width layout positions ~200×64 cards on an
 * absolutely-positioned layer, with an SVG layer underneath drawing elbow
 * connectors. The outer canvas pans (pointer drag) and zooms (wheel +
 * buttons) via a single CSS transform. Team/agent cards click through to
 * their detail pages.
 */

const NODE_W = 200;
const NODE_H = 64;
const H_GAP = 24;
const V_GAP = 56;
const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
const FIT_PADDING = 32;
const DRAG_THRESHOLD_PX = 3;

interface PlacedNode {
    key: string;
    node: OrgTreeNode;
    /** Left edge of the card, layout coordinates. */
    x: number;
    /** Top edge of the card, layout coordinates. */
    y: number;
}

interface PlacedEdge {
    key: string;
    /** SVG path for the parent-bottom → child-top elbow connector. */
    path: string;
}

interface ChartLayout {
    nodes: PlacedNode[];
    edges: PlacedEdge[];
    width: number;
    height: number;
}

function subtreeWidth(node: OrgTreeNode, cache: Map<OrgTreeNode, number>): number {
    const cached = cache.get(node);
    if (cached !== undefined) return cached;
    let width = NODE_W;
    if (node.children.length > 0) {
        let rowWidth = -H_GAP;
        for (const child of node.children) rowWidth += subtreeWidth(child, cache) + H_GAP;
        width = Math.max(width, rowWidth);
    }
    cache.set(node, width);
    return width;
}

/**
 * Pure tidy-tree layout: each node is centered above the row of its
 * children; leaf subtrees occupy exactly one card width. Elbow edges run
 * from the parent's bottom-center anchor down half the vertical gap,
 * across, then down into the child's top-center anchor.
 */
function layoutOrgTree(root: OrgTreeNode): ChartLayout {
    const cache = new Map<OrgTreeNode, number>();
    const nodes: PlacedNode[] = [];
    const edges: PlacedEdge[] = [];
    let maxTop = 0;

    const place = (node: OrgTreeNode, left: number, depth: number, key: string) => {
        const width = subtreeWidth(node, cache);
        const x = left + width / 2 - NODE_W / 2;
        const y = depth * (NODE_H + V_GAP);
        maxTop = Math.max(maxTop, y);
        nodes.push({ key, node, x, y });
        if (node.children.length === 0) return;

        let rowWidth = -H_GAP;
        for (const child of node.children) rowWidth += subtreeWidth(child, cache) + H_GAP;
        let childLeft = left + (width - rowWidth) / 2;
        const parentAnchorX = x + NODE_W / 2;
        const parentAnchorY = y + NODE_H;
        const elbowY = parentAnchorY + V_GAP / 2;
        const childTop = (depth + 1) * (NODE_H + V_GAP);

        node.children.forEach((child, index) => {
            const childWidth = subtreeWidth(child, cache);
            const childKey = `${key}.${index}`;
            const childAnchorX = childLeft + childWidth / 2;
            edges.push({
                key: childKey,
                path:
                    `M ${parentAnchorX} ${parentAnchorY} L ${parentAnchorX} ${elbowY} ` +
                    `L ${childAnchorX} ${elbowY} L ${childAnchorX} ${childTop}`,
            });
            place(child, childLeft, depth + 1, childKey);
            childLeft += childWidth + H_GAP;
        });
    };

    place(root, 0, 0, '0');
    return { nodes, edges, width: subtreeWidth(root, cache), height: maxTop + NODE_H };
}

/**
 * Kebab-case lucide ids seen in team `avatarIcon` (same convention as agent
 * templates). Explicit map — not a dynamic barrel — to keep the bundle lean;
 * unknown ids fall back to `Users`.
 */
const TEAM_ICON_BY_ID: Record<string, LucideIcon> = {
    users: Users,
    rocket: Rocket,
    wrench: Wrench,
    sparkles: Sparkles,
    'trending-up': TrendingUp,
    'pen-line': PenLine,
    shield: Shield,
    briefcase: Briefcase,
};

function nodeIcon(node: OrgTreeNode): LucideIcon {
    switch (node.kind) {
        case 'organization':
            return Building2;
        case 'team':
            return (node.avatarIcon && TEAM_ICON_BY_ID[node.avatarIcon]) || Users;
        case 'agent':
            return Bot;
        case 'member':
            return User;
    }
}

function statusDotClass(status?: string | null): string {
    switch (status) {
        case 'active':
            return 'bg-emerald-500';
        case 'paused':
        case 'draft':
            return 'bg-amber-500';
        case 'error':
            return 'bg-red-500';
        default:
            return 'bg-gray-400 dark:bg-gray-500';
    }
}

interface ChartNodeCardProps {
    placed: PlacedNode;
    onNodeClick: (node: OrgTreeNode) => void;
}

function ChartNodeCard({ placed, onNodeClick }: ChartNodeCardProps) {
    const { node } = placed;
    const Icon = nodeIcon(node);
    const interactive = node.kind === 'team' || node.kind === 'agent';

    const iconBoxClass =
        node.kind === 'organization'
            ? 'bg-info/10 border border-info/20 text-info'
            : 'bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 text-text-secondary dark:text-text-secondary-dark';

    const cardClass =
        'absolute flex items-center gap-2.5 rounded-lg border border-border/60 dark:border-border-dark/60 ' +
        'bg-card dark:bg-card-primary-dark px-3 text-left shadow-sm' +
        (interactive ? ' cursor-pointer transition-colors hover:border-primary' : '');

    const inner = (
        <>
            <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${iconBoxClass}`}
            >
                <Icon className="h-4 w-4" strokeWidth={1.5} />
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-text dark:text-text-dark">
                        {node.label}
                    </span>
                    {node.kind === 'agent' && (
                        <span
                            aria-hidden
                            className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(node.status)}`}
                        />
                    )}
                </span>
                {node.sublabel && (
                    <span className="block truncate text-xs text-text-muted dark:text-text-muted-dark">
                        {node.sublabel}
                    </span>
                )}
            </span>
        </>
    );

    const style = { left: placed.x, top: placed.y, width: NODE_W, height: NODE_H };

    if (interactive) {
        return (
            <button
                type="button"
                data-testid={`org-chart-node-${node.id}`}
                className={cardClass}
                style={style}
                onClick={() => onNodeClick(node)}
            >
                {inner}
            </button>
        );
    }
    return (
        <div data-testid={`org-chart-node-${node.id}`} className={cardClass} style={style}>
            {inner}
        </div>
    );
}

export interface OrgChartClientProps {
    payload: OrgChartPayload;
}

export function OrgChartClient({ payload }: OrgChartClientProps) {
    const t = useTranslations('dashboard.orgChartPage');
    const router = useRouter();
    const layout = useMemo(() => layoutOrgTree(buildOrgTree(payload)), [payload]);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const [view, setView] = useState({ x: FIT_PADDING, y: FIT_PADDING, scale: 1 });
    const dragRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
    } | null>(null);
    // Survives until the next pointerdown so the post-drag click is suppressed.
    const movedRef = useRef(false);

    const fitView = useCallback(() => {
        const el = containerRef.current;
        if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return;
        const fitted = Math.min(
            (el.clientWidth - FIT_PADDING * 2) / layout.width,
            (el.clientHeight - FIT_PADDING * 2) / layout.height,
            1,
        );
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fitted));
        setView({ x: (el.clientWidth - layout.width * scale) / 2, y: FIT_PADDING, scale });
    }, [layout.width, layout.height]);

    useEffect(() => {
        fitView();
    }, [fitView]);

    const zoomBy = useCallback((factor: number) => {
        const el = containerRef.current;
        const cx = el ? el.clientWidth / 2 : 0;
        const cy = el ? el.clientHeight / 2 : 0;
        setView((v) => {
            const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
            const ratio = scale / v.scale;
            return { scale, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
        });
    }, []);

    // Wheel zoom anchored on the cursor. Native listener because React
    // registers `wheel` as passive at the root, so `onWheel` can't
    // preventDefault the page scroll.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            setView((v) => {
                const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
                const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
                const ratio = scale / v.scale;
                return { scale, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        movedRef.current = false;
        dragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            originX: view.x,
            originY: view.y,
        };
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || e.pointerId !== drag.pointerId) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (!movedRef.current && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) {
            // Capture only once an actual drag starts, so plain clicks still
            // reach the node cards underneath.
            movedRef.current = true;
            e.currentTarget.setPointerCapture(drag.pointerId);
        }
        if (!movedRef.current) return;
        setView((v) => ({ ...v, x: drag.originX + dx, y: drag.originY + dy }));
    };

    const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || e.pointerId !== drag.pointerId) return;
        if (e.currentTarget.hasPointerCapture(drag.pointerId)) {
            e.currentTarget.releasePointerCapture(drag.pointerId);
        }
        dragRef.current = null;
    };

    const handleNodeClick = useCallback(
        (node: OrgTreeNode) => {
            if (movedRef.current) return;
            if (node.kind === 'team') {
                router.push(ROUTES.DASHBOARD_TEAM(node.id));
            } else if (node.kind === 'agent') {
                router.push(ROUTES.DASHBOARD_AGENT(node.id));
            }
        },
        [router],
    );

    const controlButtonClass =
        'rounded-md border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark p-1.5 ' +
        'text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors';

    return (
        <div
            ref={containerRef}
            data-testid="org-chart-canvas"
            className="relative h-[calc(100vh-260px)] min-h-[420px] w-full cursor-grab touch-none select-none overflow-hidden rounded-xl border border-border/60 dark:border-border-dark/60 bg-surface-secondary/40 dark:bg-surface-secondary-dark/20 active:cursor-grabbing"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
        >
            <div className="absolute right-3 top-3 z-10 flex gap-1.5">
                <button
                    type="button"
                    data-testid="org-chart-zoom-in"
                    aria-label={t('zoomIn')}
                    title={t('zoomIn')}
                    className={controlButtonClass}
                    onClick={() => zoomBy(1.2)}
                >
                    <ZoomIn className="h-4 w-4" strokeWidth={1.5} />
                </button>
                <button
                    type="button"
                    data-testid="org-chart-zoom-out"
                    aria-label={t('zoomOut')}
                    title={t('zoomOut')}
                    className={controlButtonClass}
                    onClick={() => zoomBy(1 / 1.2)}
                >
                    <ZoomOut className="h-4 w-4" strokeWidth={1.5} />
                </button>
                <button
                    type="button"
                    data-testid="org-chart-fit-view"
                    aria-label={t('fitView')}
                    title={t('fitView')}
                    className={controlButtonClass}
                    onClick={fitView}
                >
                    <Maximize2 className="h-4 w-4" strokeWidth={1.5} />
                </button>
            </div>
            <div
                className="absolute left-0 top-0 origin-top-left"
                style={{
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    width: layout.width,
                    height: layout.height,
                }}
            >
                <svg
                    width={layout.width}
                    height={layout.height}
                    className="pointer-events-none absolute left-0 top-0 text-border dark:text-border-dark"
                    aria-hidden
                >
                    {layout.edges.map((edge) => (
                        <path
                            key={edge.key}
                            d={edge.path}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.5}
                        />
                    ))}
                </svg>
                {layout.nodes.map((placed) => (
                    <ChartNodeCard key={placed.key} placed={placed} onNodeClick={handleNodeClick} />
                ))}
            </div>
        </div>
    );
}
