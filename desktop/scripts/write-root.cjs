// The desktop app is a window onto your checkout of Big Eyes Office: it records where that folder is.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
fs.writeFileSync(path.join(__dirname, '..', 'root.json'), JSON.stringify({ root }, null, 2));
fs.copyFileSync(path.join(root, 'web', 'public', 'icon-512.png'), path.join(__dirname, '..', 'icon.png'));
console.log(`Big Eyes Office folder: ${root}`);
