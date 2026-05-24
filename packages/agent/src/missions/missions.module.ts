import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Mission } from '../entities/mission.entity';
import { MissionsService } from './missions.service';

/**
 * Phase 3 PR G — MissionsModule skeleton (Missions/Ideas/Works
 * build).
 *
 * Mirrors the work-agent module shape: register the `Mission`
 * entity via TypeORM forFeature so the service can inject a
 * `Repository<Mission>`, expose `MissionsService` for consumers
 * (api-side controller in this PR; Phase 3 PR J tick worker
 * later; Phase 8 PR X Mission Templates scaffolder later).
 *
 * PR G ships listForUser only; PR H extends with the full CRUD
 * + lifecycle surface.
 */
@Module({
    imports: [TypeOrmModule.forFeature([Mission])],
    providers: [MissionsService],
    exports: [MissionsService],
})
export class MissionsModule {}
