import { DatabaseInitService } from '../database-init.service';

describe('DatabaseInitService.onModuleInit', () => {
    const ORIGINAL_APP_TYPE = process.env.APP_TYPE;

    let initialize: jest.Mock;
    let synchronize: jest.Mock;
    let dataSource: {
        isInitialized: boolean;
        initialize: jest.Mock;
        synchronize: jest.Mock;
    };
    let service: DatabaseInitService;
    let loggerDebug: jest.SpyInstance;
    let loggerError: jest.SpyInstance;

    beforeEach(() => {
        initialize = jest.fn().mockResolvedValue(undefined);
        synchronize = jest.fn().mockResolvedValue(undefined);
        dataSource = {
            isInitialized: false,
            initialize,
            synchronize,
        };
        service = new DatabaseInitService(dataSource as never);

        // Silence the logger output during tests but still capture invocations
        // so we can assert the documented log-line contracts below. Spying on
        // the private `logger` field via type assertion is the documented
        // pattern used by the rest of the agent test suite.
        loggerDebug = jest
            .spyOn((service as unknown as { logger: { debug: jest.Mock } }).logger, 'debug')
            .mockImplementation(() => undefined);
        loggerError = jest
            .spyOn((service as unknown as { logger: { error: jest.Mock } }).logger, 'error')
            .mockImplementation(() => undefined);
    });

    afterEach(() => {
        if (ORIGINAL_APP_TYPE === undefined) {
            delete process.env.APP_TYPE;
        } else {
            process.env.APP_TYPE = ORIGINAL_APP_TYPE;
        }
        jest.restoreAllMocks();
    });

    it('initialises the DataSource when not already initialised', async () => {
        delete process.env.APP_TYPE;

        await service.onModuleInit();

        expect(initialize).toHaveBeenCalledTimes(1);
        expect(synchronize).not.toHaveBeenCalled();
        expect(loggerDebug).toHaveBeenCalledWith('Database connection initialized');
        expect(loggerError).not.toHaveBeenCalled();
    });

    it('skips initialize() when DataSource.isInitialized is already true', async () => {
        // Pinned because re-initialising an already-active TypeORM connection throws
        // `CannotConnectAlreadyConnectedError` — the guard is load-bearing for `nest start`
        // when other modules race the bootstrap.
        delete process.env.APP_TYPE;
        dataSource.isInitialized = true;

        await service.onModuleInit();

        expect(initialize).not.toHaveBeenCalled();
        expect(synchronize).not.toHaveBeenCalled();
        expect(loggerDebug).not.toHaveBeenCalledWith('Database connection initialized');
    });

    it('runs synchronize() when APP_TYPE === "cli"', async () => {
        // Pinned because the CLI is the ONE consumer that should hot-create tables on
        // first run (no migration runner). Production API/web/trigger MUST never reach
        // this branch — `synchronize: true`-equivalent behaviour is destructive.
        process.env.APP_TYPE = 'cli';

        await service.onModuleInit();

        expect(initialize).toHaveBeenCalledTimes(1);
        expect(synchronize).toHaveBeenCalledTimes(1);
        expect(loggerDebug).toHaveBeenCalledWith('Database schema synchronized');
    });

    it('runs synchronize() AFTER initialize() (order pinned)', async () => {
        // The CLI branch depends on metadata that only exists post-initialise; pinned
        // via shared call-order array so a future swap of the two awaits has to be a
        // deliberate change.
        process.env.APP_TYPE = 'cli';
        const order: string[] = [];
        initialize.mockImplementation(async () => {
            order.push('initialize');
        });
        synchronize.mockImplementation(async () => {
            order.push('synchronize');
        });

        await service.onModuleInit();

        expect(order).toEqual(['initialize', 'synchronize']);
    });

    it('skips initialize() but STILL runs synchronize() when isInitialized=true and APP_TYPE=cli', async () => {
        // Documents the current behaviour: the synchronize gate is independent of the
        // initialize gate. A CLI consumer that bootstraps its own DataSource still gets
        // the schema sync. Pinned because this is the easy "just-tighten-the-if" mistake.
        process.env.APP_TYPE = 'cli';
        dataSource.isInitialized = true;

        await service.onModuleInit();

        expect(initialize).not.toHaveBeenCalled();
        expect(synchronize).toHaveBeenCalledTimes(1);
    });

    it('does NOT synchronize when APP_TYPE is unset', async () => {
        delete process.env.APP_TYPE;

        await service.onModuleInit();

        expect(synchronize).not.toHaveBeenCalled();
    });

    it('does NOT synchronize for non-cli APP_TYPE values (api/web/trigger)', async () => {
        // Strict equality: only the literal `'cli'` triggers synchronize. Pinned so a
        // future loose-match (e.g. APP_TYPE.includes('cli')) is a deliberate change.
        for (const appType of ['api', 'web', 'trigger', 'CLI', 'cli ', 'clix']) {
            initialize.mockClear();
            synchronize.mockClear();
            dataSource.isInitialized = false;
            process.env.APP_TYPE = appType;

            await service.onModuleInit();

            expect(synchronize).not.toHaveBeenCalled();
        }
    });

    it('rethrows initialize() errors after logging them', async () => {
        // Pinned because a swallowed initialize() failure would leave the rest of the
        // app booting with a non-functional DataSource. The catch block exists ONLY to
        // log; the rethrow is load-bearing for `nest start` to abort cleanly.
        delete process.env.APP_TYPE;
        const boom = new Error('connection refused');
        initialize.mockRejectedValueOnce(boom);

        await expect(service.onModuleInit()).rejects.toBe(boom);
        expect(loggerError).toHaveBeenCalledWith('Failed to initialize database', boom);
    });

    it('rethrows synchronize() errors after logging them', async () => {
        process.env.APP_TYPE = 'cli';
        const boom = new Error('schema sync failed');
        synchronize.mockRejectedValueOnce(boom);

        await expect(service.onModuleInit()).rejects.toBe(boom);
        expect(loggerError).toHaveBeenCalledWith('Failed to initialize database', boom);
    });

    it('logs ONCE per error (no duplicate logger.error calls in either branch)', async () => {
        delete process.env.APP_TYPE;
        const boom = new Error('connection refused');
        initialize.mockRejectedValueOnce(boom);

        await expect(service.onModuleInit()).rejects.toBe(boom);
        expect(loggerError).toHaveBeenCalledTimes(1);
    });
});
