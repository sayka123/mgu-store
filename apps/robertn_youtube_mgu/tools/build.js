'use strict';

const fs = require('fs');
const path = require('path');
const link = require('../../../tools/oap_link.js');

const appDir = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'mgu-app.json'), 'utf8'));
const output = path.join(appDir, `${manifest.id}@${manifest.version}.src.tgz`);

link.packSource(appDir, output);
console.log(`Built ${path.basename(output)}`);
