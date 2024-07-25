import pkg from './package.json' with { type: 'json' };
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import json from '@rollup/plugin-json';

export default [{
    input: 'src/main.js',
    output: [{
        file: pkg.exports.default,
        format: 'es',
    }],
    plugins: [
        resolve({ preferBuiltins: true }),
        commonjs(),
        json()
    ],
    external: [],
}, {
    input: 'src/emulator.js',
    output: [{
        file: pkg.exports.emu,
        format: 'es',
    }],
    plugins: [
        resolve({ preferBuiltins: true }),
        commonjs(),
        json()
    ],
    external: [],
}, {
    input: 'src/cli.js',
    output: [{
        file: pkg.exports.cli,
        format: 'es',
    }],
    plugins: [
        resolve({ preferBuiltins: true }),
        json()
    ],
    external: ['./main.js', './emulator.js'],
}];
