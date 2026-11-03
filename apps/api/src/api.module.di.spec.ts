import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ApiModule } from './api.module';

describe('ApiModule DI probe', () => {
    it('compiles', async () => {
        const started = Date.now();
        const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
        // eslint-disable-next-line no-console
        console.log('compiled in', Date.now() - started, 'ms');
        await moduleRef.close();
    }, 600000);
});
