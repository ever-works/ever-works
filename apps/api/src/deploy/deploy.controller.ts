import { Body, Controller, NotFoundException, Param, Post } from '@nestjs/common';
import { VercelService } from './vercel.service';
import { Directory } from '../entities/directory.entity';
import { User } from 'src/entities/user.entity';

@Controller('deploy')
export class DeployController {
    constructor(private readonly vercelService: VercelService) {}
    
    @Post('/:dirname/vercel')
    async toVercel(
        @Body('VERCEL_TOKEN') vercelToken: string | undefined,
        @Body('GITHUB_TOKEN') ghToken: string | undefined,
        @Param('dirname') slug: string
    ) {
        // some db query result:
        const directory = await Directory.findMock(slug);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }
        const user = await User.sessionMock();

        await this.vercelService.deploy({
            // TODO: replace with real username from user object:
            owner: directory.owner,
            repo: directory.getWebsiteRepo(),
            provider: 'vercel',
            data: {
                vercelToken: vercelToken || process.env.VERCEL_TOKEN, // TODO: change it before going to prod
                ghToken: ghToken || process.env.GITHUB_APIKEY, // TODO: change it before going to prod
            }
        }, directory, user);
    }
}
