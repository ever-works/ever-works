import { Module } from '@nestjs/common';
import { HomeModule as AgentHomeModule } from '@ever-works/agent/home';
import { HomeController } from './home.controller';

/**
 * Home (AW-19) — API module for `GET /api/home/summary`.
 *
 * A thin HTTP shell over the agent-side `HomeModule`, the same split the
 * Schedules and Runs endpoints use: all composition lives in
 * `packages/agent`, the controller only resolves the session and the scope.
 * `ScopeContextService` is provided globally by `ScopeModule`.
 */
@Module({
    imports: [AgentHomeModule],
    controllers: [HomeController],
})
export class HomeModule {}
