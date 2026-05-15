import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { BudgetService } from './budget.service';
import { BudgetGuardService } from './budget-guard.service';

/**
 * EW-602 — Wires the per-Work budget enforcement layer.
 *
 * Imported by FacadesModule so each capability facade can inject
 * BudgetGuardService and gate plugin calls. The actual alert delivery
 * (in-app notification + email + PostHog) is handled in Phase 2c by
 * a separate module that subscribes to BudgetThresholdCrossedEvent.
 */
@Module({
    imports: [DatabaseModule],
    providers: [BudgetService, BudgetGuardService],
    exports: [BudgetService, BudgetGuardService],
})
export class BudgetsModule {}
