import { FakerMailerService } from './faker-mailer.service';

describe('FakerMailerService', () => {
    let service: FakerMailerService;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        service = new FakerMailerService();
        debugSpy = jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('logs the recipient + subject at debug level and resolves without throwing', async () => {
        await expect(
            service.sendMail({ to: 'a@b.test', subject: 'Hello' }),
        ).resolves.toBeUndefined();
        expect(debugSpy).toHaveBeenCalledWith(
            'FakerMailerService:sendMail to=a@b.test subject="Hello"',
        );
    });

    it('renders undefined recipient and subject as-is (no exception)', async () => {
        await service.sendMail({});
        expect(debugSpy).toHaveBeenCalledWith(
            'FakerMailerService:sendMail to=undefined subject="undefined"',
        );
    });
});
