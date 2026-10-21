import { Global, Module } from '@nestjs/common';
import { AgentApprovalsModule } from '@ever-works/agent/agent-approvals';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    FLEET_HELD_CALL_FILER,
    FLEET_STATUS_READER,
    FLEET_WAKE_TOOL_PORT,
    FleetModule as AgentFleetModule,
} from '@ever-works/agent/fleet';
import { PolicyModule } from '@ever-works/agent/policy';
import { SafetyModule } from '@ever-works/agent/safety';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetConfirmationInterceptor } from './fleet-confirmation.interceptor';
import { FleetHeldCallService } from './fleet-held-call.service';
import { FleetWakeToolAdapter } from './fleet-wake-tool.adapter';
import { FleetStatusService } from './fleet-status.service';
import { FleetToolsController } from './fleet-tools.controller';
import { FleetToolsGateService } from './fleet-tools-gate.service';

/**
 * FL-19 — the Agent, MCP and CLI surface, API half:
 *
 *   - `FleetToolsController` — `GET /api/fleet/status`, `GET /api/fleet/tools/gate`;
 *   - `FleetStatusService` — the composition behind both `fleet_status` and the
 *     route, bound under `FLEET_STATUS_READER` for the Agent tool;
 *   - `FleetToolsGateService` — the per-family gate view of one Agent;
 *   - `FleetConfirmationInterceptor` — the uniform 409 `confirmation_required`;
 *   - `FleetHeldCallService` — under `FLEET_HELD_CALL_FILER`, files the Decision for a
 *     fleet act the trust ladder held (P2); `FleetHeldCallListener` (agent side) runs it.
 *
 * `@Global()` for the reason `FleetSessionsApiModule` documents: the api-side
 * `AgentsModule` binds `FLEET_STATUS_READER` into the Agent's domain tool
 * sources `@Optional()` and must not import this module. `FleetSessionService`
 * reaches the status service through the global sessions module (optional).
 * No provider here injects the Agent tool assembly back, so there is no cycle.
 */
@Global()
@Module({
    imports: [AgentFleetModule, DatabaseModule, SafetyModule, PolicyModule, AgentApprovalsModule],
    controllers: [FleetToolsController],
    providers: [
        FleetStatusService,
        { provide: FLEET_STATUS_READER, useExisting: FleetStatusService },
        FleetToolsGateService,
        // T-08 — the uniform `confirmation_required` answer, applied per family controller.
        FleetConfirmationInterceptor,
        // P2 — a held fleet act becomes a Decision (the run loop asks under FLEET_HELD_CALL_FILER).
        FleetHeldCallService,
        { provide: FLEET_HELD_CALL_FILER, useExisting: FleetHeldCallService },
        // P2 — `fleet_nodes_wake` runs FL-03's wake route as the Agent's owner.
        FleetWakeToolAdapter,
        { provide: FLEET_WAKE_TOOL_PORT, useExisting: FleetWakeToolAdapter },
        FleetEnabledGuard,
    ],
    exports: [
        FleetStatusService,
        FLEET_STATUS_READER,
        FleetToolsGateService,
        FleetConfirmationInterceptor,
        FleetHeldCallService,
        FLEET_HELD_CALL_FILER,
        FLEET_WAKE_TOOL_PORT,
    ],
})
export class FleetToolsApiModule {}
