const fs = require('fs');

let code = fs.readFileSync('src/seed.js', 'utf8');

// 1. replace imports
code = code.replace(/import db from '\.\/db\.js';/g, '');
code = code.replace(/import \{ migrate, run, all, get, tx \} from '\.\/db\.js';/g, "import { migrate, run, all, get, tx } from './db.js';");

// 2. Make the main block an async IIFE
code = code.replace(/migrate\(\);/, 'await migrate();');

code = code.replace(/db\.exec\(`DELETE FROM \$\{t\}`\);/g, 'await run(`DELETE FROM ${t}`);');

code = code.replace(/tx\(\(\) => \{/g, 'await tx(async () => {');

// 3. await all run, get, all
const replacements = [
  { p: /([^\w\.])(all\()/g, r: '$1await $2' },
  { p: /([^\w\.])(get\()/g, r: '$1await $2' },
  { p: /([^\w\.])(run\()/g, r: '$1await $2' },
];

for (const {p, r} of replacements) {
  code = code.replace(p, r);
}

// 4. Wrap everything after console.log in an async function
let parts = code.split("console.log('EcoSphere :: seeding');");
code = parts[0] + "console.log('EcoSphere :: seeding');\n\n(async () => {\n" + parts[1] + "\n})();";

// clean up double awaits
code = code.replace(/await\s+await\s+/g, 'await ');

fs.writeFileSync('src/seed.js', code);
console.log('Done rewriting seed.js');
