'use client';

import { useState } from 'react';
import type { RecordAggregate } from '@/lib/record-visibility';
import { RecordTeamsEditor } from './RecordTeamsEditor';
import { VisibilityControl } from './VisibilityControl';

/**
 * Record visibility (EW-P1-3, spec §7) — the visibility control, plus (goal form) the
 * record's Teams. Saving the Teams can move an automatic record between `team` and
 * `organization`, so the control re-reads after every Teams save.
 */
export function RecordVisibilityPanel({
    aggregate,
    id,
    showTeams = false,
    className,
}: {
    aggregate: RecordAggregate;
    id: string;
    showTeams?: boolean;
    className?: string;
}) {
    const [revision, setRevision] = useState(0);
    return (
        <div
            className={`flex flex-col gap-4 ${className ?? ''}`}
            data-testid="record-visibility-panel"
        >
            <VisibilityControl key={revision} aggregate={aggregate} id={id} />
            {showTeams ? (
                <RecordTeamsEditor
                    aggregate={aggregate}
                    id={id}
                    onChange={() => setRevision((value) => value + 1)}
                />
            ) : null}
        </div>
    );
}
