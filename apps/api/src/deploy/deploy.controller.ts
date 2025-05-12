import {
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { VercelService } from './vercel.service';
import { Directory } from '../entities/directory.entity';
import { User } from 'src/entities/user.entity';
import { DeployVercelDto } from './deploy-vercel.dto';

@Controller('deploy')
export class DeployController {
  constructor(private readonly vercelService: VercelService) {}

  @Post('/:dirname/vercel')
  @UsePipes(new ValidationPipe({ transform: true }))
  async toVercel(
    @Body() deployVercel: DeployVercelDto,
    @Param('dirname') slug: string,
  ) {
    const { VERCEL_TOKEN: vercelToken, GITHUB_TOKEN: ghToken } = deployVercel;

    // some db query result:
    const directory = await Directory.findMock(slug);
    if (!directory) {
      throw new NotFoundException('Directory not found');
    }
    const user = await User.sessionMock();

    await this.vercelService.deploy(
      {
        // TODO: replace with real username from user object:
        owner: directory.owner,
        repo: directory.getWebsiteRepo(),
        provider: 'vercel',
        data: {
          vercelToken: vercelToken || process.env.VERCEL_TOKEN, // TODO: change it before going to prod
          ghToken: ghToken || process.env.GITHUB_APIKEY, // TODO: change it before going to prod
        },
      },
      directory,
      user,
    );
  }
}
