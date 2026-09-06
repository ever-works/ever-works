import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import {
    AgentPluginPackageAllowlist,
    type AgentPluginPackageAllowlistSource,
} from '../entities/agent-plugin-package-allowlist.entity';

/**
 * Authorisation gate for REMOTE Agent Plugins sources.
 *
 * Two properties matter more than anything else here, and both are easy to
 * lose in a later refactor:
 *
 * 1. **It is consulted BEFORE any network fetch.** The code-plugin installer
 *    establishes this rule (FR-11) and it is not merely tidiness: resolving an
 *    npm manifest or contacting a git remote for a package nobody authorised
 *    leaks the fact that this deployment is interested in it, and hands an
 *    attacker-chosen server a connection before any policy has run. A check
 *    performed after the fetch is not the same control.
 *
 * 2. **It fails CLOSED.** If the allowlist cannot be read — no repository
 *    bound, database unreachable — every remote package is refused. The
 *    tempting alternative (treat an unreadable allowlist as empty, and an
 *    empty allowlist as "no restrictions configured") turns a database blip
 *    into unrestricted remote code acquisition. See
 *    `bug_class_caller_declared_security_ceiling`: a permission that fails
 *    open is not a permission.
 *
 * `local` packages are deliberately NOT gated. A local package already sits in
 * a directory the operator configured and controls; requiring an allowlist row
 * would be asking their permission for bytes they put there themselves.
 */
@Injectable()
export class AgentPluginAllowlistService {
    private readonly logger = new Logger(AgentPluginAllowlistService.name);

    constructor(
        // Optional so the module remains loadable in contexts with no
        // database (the CLI's read-only paths, unit tests of the local
        // source). An ABSENT repository refuses every remote package rather
        // than allowing it — see the fail-closed note above.
        @Optional()
        @InjectRepository(AgentPluginPackageAllowlist)
        private readonly repository?: Repository<AgentPluginPackageAllowlist>,
    ) {}

    /**
     * Decide whether `packageName` may be fetched from `source`.
     *
     * The returned `reason` is surfaced to the operator verbatim, so it names
     * what to do next rather than merely stating the refusal.
     */
    async check(
        packageName: string,
        source: AgentPluginPackageAllowlistSource,
    ): Promise<{ allowed: boolean; reason: string; entry?: AgentPluginPackageAllowlist }> {
        if (!this.repository) {
            return {
                allowed: false,
                reason:
                    `Refusing to fetch "${packageName}": the Agent Plugins allowlist is ` +
                    `unavailable in this context, so no remote source can be authorised.`,
            };
        }

        let entry: AgentPluginPackageAllowlist | null;
        try {
            entry = await this.repository.findOne({ where: { packageName, source } });
        } catch (err) {
            // A read failure is not an empty allowlist. Refuse, and say why —
            // an operator seeing this needs to know it is an outage and not a
            // missing entry they should go and create.
            const detail = err instanceof Error ? err.message : String(err);
            this.logger.error(
                `Agent Plugins allowlist lookup failed for ${source}:${packageName} — refusing: ${detail}`,
            );
            return {
                allowed: false,
                reason:
                    `Refusing to fetch "${packageName}": the allowlist could not be read ` +
                    `(${detail}). This is a lookup failure, not a missing entry.`,
            };
        }

        if (!entry) {
            return {
                allowed: false,
                reason:
                    `"${packageName}" is not on the Agent Plugins allowlist for source ` +
                    `"${source}". Add an allowlist entry before installing it.`,
            };
        }

        if (!entry.enabled) {
            return {
                allowed: false,
                reason:
                    `The allowlist entry for "${packageName}" (${source}) is disabled. ` +
                    `Re-enable it to allow this package again.`,
                entry,
            };
        }

        return { allowed: true, reason: 'allowed', entry };
    }
}
