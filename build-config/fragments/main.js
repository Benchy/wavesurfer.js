/* eslint-env node */

const path = require('path');
const banner = require('./banner');

const rootDir = path.resolve(__dirname, '..', '..');

module.exports = {
    entry: {
        wavesurfer: path.join(rootDir, 'src', 'index.js')
    },
    output: {
        path: path.join(rootDir, 'dist'),
        filename: 'index.js',
        library: 'WaveSurfer',
        libraryTarget: 'umd', // Or 'var' by default,
        umdNamedDefine: true,
};
