const fs = require('fs');

let code = fs.readFileSync('src/routes/index.js', 'utf8');

const replacements = [
  { p: /([^\w\.])(all\()/g, r: '$1await $2' },
  { p: /([^\w\.])(get\()/g, r: '$1await $2' },
  { p: /([^\w\.])(run\()/g, r: '$1await $2' },
  { p: /([^\w\.])(audit\()/g, r: '$1await $2' },
  { p: /([^\w\.])(tx\()/g, r: '$1await $2' },
  { p: /([^\w\.])(auth\.[a-zA-Z]+\()/g, r: '$1await $2' },
  { p: /([^\w\.])(esg\.[a-zA-Z]+\()/g, r: '$1await $2' },
  { p: /([^\w\.])(gamify\.[a-zA-Z]+\()/g, r: '$1await $2' }
];

for (const {p, r} of replacements) {
  code = code.replace(p, r);
}

// Clean up double awaits
code = code.replace(/await\s+await\s+/g, 'await ');

// Fix tx() callbacks
code = code.replace(/tx\(await \(\) =>/g, 'tx(async () =>');
code = code.replace(/tx\(await async \(\) =>/g, 'tx(async () =>');
code = code.replace(/await tx\(\(\) =>/g, 'await tx(async () =>');

// Fix `import { await all, ... }` side effect
code = code.replace(/import\s+\{\s+await\s+/g, 'import { ');
code = code.replace(/,\s+await\s+/g, ', ');

fs.writeFileSync('src/routes/index.js', code);
console.log('Done rewriting routes');
