import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { parsePackageDirs } from './local-source';
import { acquireInputFor } from './package-bootstrap.service';
import { config } from '../config';
import { AgentPluginPackageRepository } from './package.repository';
import { AgentPluginRemoteAcquireService, type AcquireInput } from './remote-acquire.service';
import type { AgentPluginPackage } from '../entities/agent-plugin-package.entity';

/**
 * Install and remove remote Agent Plugins packages.
 *
 * Sits between the API controller and the acquirer, and owns the one thing
 * neither of them does: keeping the registry row and the bytes on disk
 * agreeing with each other.
 *
 * Ordering matters in both directions:
 *
 * - **Install** acquires FIRST and writes the row only after validation
 *   succeeds. A row written first would advertise a package that might never
 *   materialise, and the catalog would offer a skill that cannot be read.
 * - **Remove** deletes the row FIRST and the directory second. The reverse
 *   order leaves a window where the row points at a directory that is already
 *   gone; a failure midway through then leaves a permanently broken row. This
 *   way a failure leaves an orphaned directory instead, which the next install
 *   overwrites and which nothing reads.
 */
@Injectable()
export class AgentPluginInstallService {
    private readonly logger = new Logger(AgentPluginInstallService.name);

    constructor(
        private readonly repository: AgentPluginPackageRepository,
        private readonly acquirer: AgentPluginRemoteAcquireService,
    ) {}

    async install(
        input: AcquireInput,
        owner: { userId: string; tenantId?: string | null; organizationId?: string | null },
    ): Promise<AgentPluginPackage> {
        this.assertEnabled();
        const root = this.packagesRoot();

        const acquired = await this.acquirer.acquire(root, input);
        if (!acquired.load.ok) {
            // Unreachable — `acquire` throws on a failed load — but asserted
            // rather than assumed, because the alternative is persisting a row
            // for a package that was rejected.
            throw new HttpException(
                {
                    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
                    message: 'Package failed validation.',
                },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }

        const pkg = acquired.load;
        const row = await this.repository.upsertInstalled({
            userId: owner.userId,
            tenantId: owner.tenantId ?? null,
            organizationId: owner.organizationId ?? null,
            name: pkg.manifest.name,
            version: pkg.manifest.version ?? null,
            specVersion: pkg.specVersion,
            source: input.kind,
            sourceRef: sourceRefFor(input),
            installPath: acquired.path,
            integrity: acquired.kind === 'npm' ? acquired.integrity : acquired.revision,
            manifest: pkg.manifest as unknown as Record<string, unknown>,
            findings: pkg.findings.map((finding) => ({ ...finding })),
            skillNames: pkg.skills.map((skill) => skill.name),
            mcpServerNames: pkg.mcpServers.map((server) => server.name),
        });

        this.logger.log(
            `Installed ${input.kind} package "${pkg.manifest.name}" for ${owner.userId}`,
        );
        return row;
    }

    /**
     * Remove a package the caller owns.
     *
     * Ownership is checked here rather than left to the controller: this is
     * the only method that can compare the row's `userId` to the caller, and a
     * check the caller performs is a check the next caller can forget.
     */
    async remove(id: string, userId: string): Promise<void> {
        const row = await this.repository.findById(id);
        if (!row) {
            throw new HttpException(
                { statusCode: HttpStatus.NOT_FOUND, message: 'Package not found.' },
                HttpStatus.NOT_FOUND,
            );
        }
        if (row.userId !== userId) {
            // 404 rather than 403: a 403 confirms the row exists, which tells
            // an unauthorised caller something about another user's packages.
            throw new HttpException(
                { statusCode: HttpStatus.NOT_FOUND, message: 'Package not found.' },
                HttpStatus.NOT_FOUND,
            );
        }
        if (row.source === 'local') {
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message:
                        'A local package cannot be removed here — it is the directory the ' +
                        'operator configured. Remove the directory instead.',
                },
                HttpStatus.CONFLICT,
            );
        }

        await this.repository.deleteById(id);
        if (row.installPath) {
            await rm(row.installPath, { recursive: true, force: true }).catch((err: unknown) => {
                // The row is already gone, so the package is no longer
                // reachable; an orphaned directory is untidy, not incorrect.
                this.logger.warn(
                    `Removed package row ${id} but could not delete ${row.installPath}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            });
        }
    }

    /** Re-fetch a package at its recorded coordinates. */
    async resync(id: string, userId: string): Promise<AgentPluginPackage> {
        const row = await this.repository.findById(id);
        if (!row || row.userId !== userId) {
            throw new HttpException(
                { statusCode: HttpStatus.NOT_FOUND, message: 'Package not found.' },
                HttpStatus.NOT_FOUND,
            );
        }
        if (row.source === 'local') {
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message: 'A local package has no remote to re-sync from.',
                },
                HttpStatus.CONFLICT,
            );
        }
        const input = acquireInputFor(row);
        if (!input) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
                    message: `Cannot re-sync: sourceRef "${row.sourceRef}" is not usable.`,
                },
                HttpStatus.UNPROCESSABLE_ENTITY,
            );
        }
        return this.install(input, {
            userId: row.userId,
            tenantId: row.tenantId ?? null,
            organizationId: row.organizationId ?? null,
        });
    }

    private assertEnabled(): void {
        if (!config.agentPlugins.isEnabled()) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.NOT_IMPLEMENTED,
                    message:
                        'Agent Plugins support is disabled on this deployment. Set ' +
                        'FEATURE_AGENT_PLUGINS=true to enable it.',
                },
                HttpStatus.NOT_IMPLEMENTED,
            );
        }
    }

    private packagesRoot(): string {
        const root = parsePackageDirs(config.agentPlugins.getPackageDirs())[0];
        if (!root) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
                    message: 'No Agent Plugins package directory is configured.',
                },
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
        return root;
    }
}

/** The durable coordinates for re-fetching, matching `sourceRef`'s documented shape. */
export function sourceRefFor(input: AcquireInput): string {
    if (input.kind === 'git') {
        return input.ref ? `${input.url}#${input.ref}` : input.url;
    }
    return input.version ? `${input.packageName}@${input.version}` : input.packageName;
}
