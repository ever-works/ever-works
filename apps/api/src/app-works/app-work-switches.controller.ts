import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { readAppWorkSwitches, type AppWorkSwitches } from '@ever-works/agent/app-works';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * APW-08 T49 (XC-10, FR-74, R-30, S34) — the operator's App Works switches, as the web reads them.
 *
 * R-30's "App Works off" makes the UI read-only with a banner while the switch stops new work.
 * The switches are read by the dispatchers themselves (`readAppWorkSwitches`, fail closed); this
 * route only lets the App Work pages SAY so, before a member asks for a change that would be
 * refused anyway. Two booleans of installation config: no Work, no owner, nothing secret — so
 * any signed-in caller may read them, and the answer is the same for everyone.
 */
@ApiTags('App Works')
@Controller('api/app-works')
export class AppWorkSwitchesController {
    @Get('switches')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Read the App Works operator switches',
        description:
            'Whether new App Work change runs may start (`EVER_WORKS_APP_CHANGES_ENABLED`) and whether a deployable Build may deploy itself (`EVER_WORKS_APP_AUTO_DEPLOY_ENABLED`). Unset reads as on; an unrecognised value reads as off (fail closed). The web shows a read-only banner while changes are off.',
    })
    @ApiResponse({ status: 200, description: '`{ changesEnabled, autoDeployEnabled }`.' })
    @ApiResponse({ status: 401, description: 'No session.' })
    getSwitches(@CurrentUser() _auth: AuthenticatedUser): AppWorkSwitches {
        const { changesEnabled, autoDeployEnabled } = readAppWorkSwitches();
        return { changesEnabled, autoDeployEnabled };
    }
}
