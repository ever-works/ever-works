import { program } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

program.version(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), { encoding: 'utf-8' })).version);

program.parse(process.argv);

const options = program.opts();

console.log('options: ', options);
