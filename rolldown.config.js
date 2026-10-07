import { defineConfig } from 'rolldown';
import pkg from './package.json' with { type: 'json' };

export default defineConfig([{
    input: 'src/main.js',
    platform: 'node',
    output: {
        file: pkg.exports.default,
        format: 'es',
    },
}, {
    input: 'src/cli.js',
    platform: 'node',
    output: {
        file: pkg.exports.cli,
        format: 'es',
    },
    external: ['./main.js'],
}]);
