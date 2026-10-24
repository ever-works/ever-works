import {
    parseFleetGitLine,
    parseFleetRemote,
    type FleetCheckoutView,
    type FleetNodeCheckoutBusyReason,
} from '@ever-works/contracts';
import type { FleetCheckout } from '../../entities/fleet-checkout.entity';
import { checkoutSizeBytes, isCheckoutFolderRemoved } from './fleet-checkout.policy';

function iso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** What the last node list said about a row that is not stored (busy, the reaper's note). */
export interface FleetCheckoutLiveFacts {
    busy?: FleetNodeCheckoutBusyReason | null;
    reaperNote?: string | null;
}

/**
 * One row as every surface reads it (REST, tools, CLI `--json`). `workName`
 * is passed in only when the viewer may see the Work (the Node's owner);
 * anyone else sees that a Work is linked, never its name.
 */
export function toFleetCheckoutView(
    row: FleetCheckout,
    extras: { workName?: string | null; live?: FleetCheckoutLiveFacts } = {},
): FleetCheckoutView {
    const remote = row.remoteUrl ? parseFleetRemote(row.remoteUrl) : null;
    return {
        id: row.id,
        nodeId: row.nodeId,
        userId: row.userId,
        path: row.path,
        kind: row.kind,
        parentCheckoutId: row.parentCheckoutId ?? null,
        remoteUrl: row.remoteUrl ?? null,
        remoteHadCredential: row.remoteHadCredential === true,
        repository: remote ? `${remote.owner}/${remote.repo}` : null,
        repositoryHost: remote?.host ?? null,
        workId: row.workId ?? null,
        workName: extras.workName ?? null,
        branch: row.branch ?? null,
        baseRef: row.baseRef ?? null,
        isolation: row.isolation,
        state: row.state,
        createdBy: row.createdBy,
        gitLine: parseFleetGitLine(row.gitLine),
        lastCommand: row.lastCommand ?? null,
        sizeBytes: checkoutSizeBytes(row.sizeBytes),
        lastSeenAt: iso(row.lastSeenAt),
        archivedAt: iso(row.archivedAt),
        folderRemoved: isCheckoutFolderRemoved(row),
        reaperNote: extras.live?.reaperNote ?? null,
        busy: extras.live?.busy ?? null,
        createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
        updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    };
}
