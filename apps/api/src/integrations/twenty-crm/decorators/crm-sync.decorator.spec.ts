import { Reflector } from '@nestjs/core';
import { CRM_SYNC_KEY, CrmSync } from './crm-sync.decorator';

describe('CrmSync decorator', () => {
    it('attaches metadata under the CRM_SYNC_KEY token (default true)', () => {
        class Target {}
        const decorator = CrmSync();
        decorator(Target);

        expect(new Reflector().get(CRM_SYNC_KEY, Target)).toBe(true);
    });

    it('attaches metadata when explicitly enabled', () => {
        class Target {}
        const decorator = CrmSync(true);
        decorator(Target);

        expect(new Reflector().get(CRM_SYNC_KEY, Target)).toBe(true);
    });

    it('attaches metadata when explicitly disabled (false is preserved, not skipped)', () => {
        class Target {}
        const decorator = CrmSync(false);
        decorator(Target);

        expect(new Reflector().get(CRM_SYNC_KEY, Target)).toBe(false);
    });

    it('exports the metadata key as a stable string constant', () => {
        // Pinned so a rename doesn't accidentally invalidate previously-set
        // metadata in production.
        expect(CRM_SYNC_KEY).toBe('crm_sync');
    });
});
