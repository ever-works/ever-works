import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    AgentPluginExportService,
    AgentPluginInstallService,
    AgentPluginPackageCatalogService,
    AgentPluginUpdateService,
    loadedPackages,
    rejectedPackages,
    scanConfiguredPackages,
    type AcquireInput,
} from '@ever-works/agent/agent-plugins';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    InstallAgentPluginPackageDto,
    ListAgentPluginPackagesQueryDto,
} from './dto/agent-plugin.dto';

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
 * Local packages have no write routes: such a package IS the directory the
 * operator configured, so "removing" one through the API would only
 * disagree with the filesystem until the next scan. Only git and npm
 * packages can be installed, re-synced and removed here.
 */
@ApiTags('agent-plugins')
@Controller('api/agent-plugins')
export class AgentPluginsController {
    constructor(
        private readonly catalog: AgentPluginPackageCatalogService,
        private readonly installer: AgentPluginInstallService,
        private readonly updateService: AgentPluginUpdateService,
        private readonly exporter: AgentPluginExportService,
    ) {}

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

    @Get('updates')
    @ApiOperation({
        summary: 'Packages with a newer version available',
        description:
            'Reports only. Upgrading changes the instructions an agent follows, so it stays an explicit action rather than a side effect of rendering this page. Packages whose remote could not be reached are listed separately from packages that are up to date.',
    })
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async listUpdates(@CurrentUser() _auth: AuthenticatedUser) {
        return this.updateService.checkForUpdates();
    }

    @Get('descriptor')
    @ApiOperation({
        summary: 'The Ever Works MCP server as an Agent Plugins package',
        description:
            'Returns the package files so any conforming client can consume this MCP server by installing a package rather than by hand-configuring it. Contains no credentials: the specification treats package headers as visible and non-secret, so the consuming client supplies its own authentication.',
    })
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async descriptor(@CurrentUser() _auth: AuthenticatedUser, @Query('url') url?: string) {
        const built = await this.exporter.buildEverWorksMcpDescriptor(url ? { url } : {});
        return { files: Object.fromEntries(built.files), findings: built.findings };
    }

    @Post()
    @ApiOperation({
        summary: 'Install a package from git or npm',
        description:
            'Requires an allowlist entry for the exact package name or git URL. The fetched tree is validated before it is kept — a package that fails is deleted rather than left on disk.',
    })
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async install(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: InstallAgentPluginPackageDto,
    ) {
        const row = await this.installer.install(toAcquireInput(body), { userId: auth.userId });
        return { id: row.id, name: row.name, version: row.version, source: row.source };
    }

    @Post(':id/resync')
    @ApiOperation({
        summary: 'Re-fetch a package at its recorded coordinates',
        description:
            'The explicit counterpart to the update badge. Re-runs the same acquire-and-validate path as an install.',
    })
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async resync(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        const row = await this.installer.resync(id, auth.userId);
        return { id: row.id, name: row.name, version: row.version, source: row.source };
    }

    @Delete(':id')
    @HttpCode(204)
    @ApiOperation({
        summary: 'Remove an installed package',
        description:
            'Deletes the registry row and then the directory. A package the caller does not own reports 404 rather than 403, so the response does not confirm that another user’s package exists.',
    })
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        await this.installer.remove(id, auth.userId);
    }
}

/**
 * Turn the flat request body into the acquirer's discriminated input.
 *
 * The DTO cannot express "url required when source is git" with
 * class-validator alone without a custom constraint, so the pairing is checked
 * here — and rejected with a message naming the missing field, because
 * `BadRequestException` with no detail is the least useful 400 there is.
 */
export function toAcquireInput(body: InstallAgentPluginPackageDto): AcquireInput {
    if (body.source === 'git') {
        if (!body.url) {
            throw new BadRequestException('A git package requires "url".');
        }
        return { kind: 'git', url: body.url, ...(body.ref ? { ref: body.ref } : {}) };
    }
    if (!body.packageName) {
        throw new BadRequestException('An npm package requires "packageName".');
    }
    return {
        kind: 'npm',
        packageName: body.packageName,
        ...(body.version ? { version: body.version } : {}),
    };
}
