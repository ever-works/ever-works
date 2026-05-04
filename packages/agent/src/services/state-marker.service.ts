import { Injectable, Logger } from '@nestjs/common';

/**
 * Minimal commit-a-single-file surface used by the state marker writer.
 * The concrete implementation lives in `@ever-works/agent/git` and uses the
 * `git-provider` plugin's local clone+commit+push primitives. We keep the
 * interface narrow here so unit tests can supply trivial fakes.
 */
export interface MarkerFileWriter {
    /**
     * Idempotently write `path` with `contents` to the repo at `repoUrl` on
     * `branch`, signed with `commitMessage`. If the file already contains the
     * exact same bytes, the implementation MUST be a no-op (no new commit)
     * to avoid CI-loop noise.
     */
    writeFile(args: {
        readonly repoUrl: string;
        readonly token: string;
        readonly branch?: string;
        readonly path: string;
        readonly contents: string;
        readonly commitMessage: string;
    }): Promise<void>;
}

export interface StateMarkerInput {
    readonly repoUrl: string;
    readonly token: string;
    readonly branch?: string;
    /** Absolute path inside the repo, must start with `.works/`. */
    readonly markerPath?: string;
    readonly state: StateMarkerPayload;
}

export interface StateMarkerPayload {
    readonly status: 'deployed' | 'failed' | 'rejected' | 'queued' | 'generating';
    readonly workId: string;
    readonly subdomain: string;
    readonly deploymentUrl?: string;
    readonly updatedAt: string;
    readonly deliveryId: string;
    readonly failureCode?: string;
    readonly failureMessage?: string;
}

const DEFAULT_MARKER_PATH = '.works/state.json';

@Injectable()
export class StateMarkerService {
    private readonly logger = new Logger(StateMarkerService.name);

    constructor(private readonly writer: MarkerFileWriter) {}

    async write(input: StateMarkerInput): Promise<void> {
        const path = input.markerPath ?? DEFAULT_MARKER_PATH;
        if (!path.startsWith('.works/')) {
            throw new Error(
                `state marker path must live under .works/ — got ${path} (FR-26a)`,
            );
        }

        const contents = JSON.stringify(input.state, null, 2) + '\n';
        const message = `chore(state): ${input.state.status} — work=${input.state.workId} (delivery ${input.state.deliveryId})`;

        try {
            await this.writer.writeFile({
                repoUrl: input.repoUrl,
                token: input.token,
                branch: input.branch,
                path,
                contents,
                commitMessage: message,
            });
            this.logger.log(
                `state_marker.written repo=${redactRepoUrl(input.repoUrl)} status=${input.state.status} delivery=${input.state.deliveryId}`,
            );
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `state_marker.failed repo=${redactRepoUrl(input.repoUrl)} reason=${reason}`,
            );
            throw err;
        }
    }
}

export const STATE_MARKER_DEFAULT_PATH = DEFAULT_MARKER_PATH;

function redactRepoUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.hostname}${u.pathname}`;
    } catch {
        return '[invalid-url]';
    }
}
