import fs from 'fs';
import { STRINGS } from '../js/i18n.js';

const main = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const keys = new Set();
for (const match of main.matchAll(/t\(state\.lang,\s*'([^']+)'/g)) keys.add(match[1]);
for (const match of main.matchAll(/t\(state\.lang,\s*"([^"]+)"/g)) keys.add(match[1]);
for (const match of fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').matchAll(/data-i18n(?:-ph|-title)?="([^"]+)"/g)) keys.add(match[1]);

const missing = [...keys].filter((key) => !(key in STRINGS.pt));
const missingEn = [...keys].filter((key) => !(key in STRINGS.en));
console.log('referenced keys:', keys.size);
console.log('missing pt:', missing);
console.log('missing en:', missingEn);
const unused = Object.keys(STRINGS.pt).filter((key) => !keys.has(key) && !['levelNames', 'commandGroups', 'examples'].includes(key));
console.log('unused pt keys:', unused);
