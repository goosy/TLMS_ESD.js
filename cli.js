import { run } from './src/index.js';
import mri from 'mri';

const argv = mri(process.argv.slice(2), {
    boolean: ['help', 'version'],
    alias: {
        H: 'help',
        V: 'version',
    }
});
const controller_name = argv._[0];
process.chdir('.');
run(controller_name);