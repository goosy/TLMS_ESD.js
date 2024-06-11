import { run } from './src/index.js';

process.chdir('./example');
const controller_name = process.argv[2];
run(controller_name);
