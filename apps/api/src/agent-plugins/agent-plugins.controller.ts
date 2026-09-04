import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    AgentPluginPackageCatalogService,
    loadedPackages,
    rejectedPackages,
    scanConfiguredPackages,
} from '@ever-works/agent/agent-plugins';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ListAgentPluginPackagesQueryDto } from './dto/agent-plugin.dto';

/**
 * Read surface over installed Agent Plugins packages.
 *
 * The controller path starts with `api/` because there is **no**
 * `setGlobalPrefix` in this application — every controller carries the
 * segment itself. A path without it registers fine, compiles, passes unit
 * tests, and 404s in production; a source-scanning guard spec exists because
 * that once blocked every signup for two days.
 *
 * Authentication is global (`AuthSessionGuard` as an `APP_GUARD`), so a
 * user-scoped controller needs no `@UseGuards` of its own.
 *
 * Read-only in this phase. Installing, updating and removing packages arrive
 * with the git and npm sources; local packages are registered in place, so
 * there is nothing yet for a write route to do that editing the directory
 * does not already do.
 */
@ApiTags('agent-plugins')
@Controller('api/agent-plugins')
export class AgentPluginsController {
    constructor(private readonly catalog: AgentPluginPackageCatalogService) {}

    @Get()
    @ApiOperation({
        summary: 'List installed Agent Plugins packages',
        description:
            'Returns every package discovered in the configured directories, including ones that failed to load — those are reported with their findings rather than hidden, since an operator put them there deliberately.',
    })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async list(
        @CurrentUser() _auth: AuthenticatedUser,
        @Query() query: ListAgentPluginPackagesQueryDto,
    ) {
        const scan = await scanConfiguredPackages();

        const loaded = loadedPackages(scan).map((pkg) => ({
            name: pkg.name,
            version: pkg.version,
            specVersion: pkg.specVersion,
            path: pkg.path,
            dirName: pkg.dirName,
            skills: pkg.skillNames,
            mcpServers: pkg.mcpServerNames,
            findings: pkg.findings,
            summary: pkg.summary,
        }));

        const rejected = rejectedPackages(scan).map((pkg) => ({
            dirName: pkg.dirName,
            path: pkg.path,
            findings: pkg.findings,
            summary: pkg.summary,
        }));

        const search = query.search?.trim().toLowerCase();
        const packages = search
            ? loaded.filter(
                  (pkg) =>
                      pkg.name?.toLowerCase().includes(search) ||
                      pkg.skills.some((skill) => skill.toLowerCase().includes(search)),
              )
            : loaded;

        return {
            // Distinguishes "the feature is off" from "on, and there are no
            // packages" — without it an operator who flips the flag and sees
            // an empty list cannot tell which they are looking at.
            enabled: scan.enabled,
            roots: scan.roots,
            packages,
            rejected,
            shadowed: scan.shadowed.map((pkg) => ({ dirName: pkg.dirName, name: pkg.name })),
        };
    }

    // Declared BEFORE any `:param` route. A `@Get(':id')` with a
    // `ParseUUIDPipe` shadows every literal sibling declared after it and 400s
    // on them, which is documented in the skills controller after it bit
    // someone there.
    @Get('findings')
    @ApiOperation({
        summary: 'Every finding across installed packages',
        description:
            'Flattened for an operator triaging why a skill or MCP server is missing. Findings are recorded at validation time, so they survive a package becoming unreadable.',
    })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async findings(@CurrentUser() _auth: AuthenticatedUser) {
        const scan = await scanConfiguredPackages();
        const all = scan.scans.flatMap((source) =>
            source.candidates.flatMap((pkg) =>
                pkg.findings.map((finding) => ({
                    package: pkg.name ?? pkg.dirName,
                    packageLoaded: pkg.ok,
                    ...finding,
                })),
            ),
        );
        return { enabled: scan.enabled, findings: all };
    }

    @Get('catalog')
    @ApiOperation({
        summary: 'Package skills as catalog entries',
        description:
            'The same entries the skills catalog merges in, exposed directly so an operator can confirm what a package contributes without hunting for it among the built-in skills.',
    })
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async catalogEntries(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListAgentPluginPackagesQueryDto,
    ) {
        const entries = await this.catalog.listEntries({
            facadeOptions: { userId: auth.userId },
            ...(query.search === undefined ? {} : { search: query.search }),
        });
        return { entries, total: entries.length };
    }
}
