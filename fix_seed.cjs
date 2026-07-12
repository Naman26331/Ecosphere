const fs = require('fs');

let code = fs.readFileSync('src/seed.js', 'utf8');

// Fix async arrow functions
code = code.replace(/const windowEmissions = \(code, fromDays, toDays\) =>/g, 'const windowEmissions = async (code, fromDays, toDays) =>');
code = code.replace(/const addRow = \(code, factorId, daysAgo, co2, type = 'manual', documentRef = null, confidence = null\) => \{/g, 'const addRow = async (code, factorId, daysAgo, co2, type = "manual", documentRef = null, confidence = null) => {');

// Fix the call sites of those async functions
code = code.replace(/windowEmissions\(/g, 'await windowEmissions(');
code = code.replace(/addRow\(/g, 'await addRow(');

// Fix SQLite date syntax in seed.js to be compatible with Postgres
// date('now', ?), ? is like '-180 days'
// For windowEmissions:
code = code.replace(/date\('now', \?\)/g, 'NOW() + CAST(? AS INTERVAL)');
// Wait, CAST(? AS INTERVAL) doesn't always work perfectly in node-pg with bound params, but we'll try. 
// Or better, just interpolate the days directly since it's a seed script!
code = code.replace(/date\('now', \?\)/g, "NOW() - (REPLACE(CAST(? AS TEXT), '-', '') || ' days')::INTERVAL");

// Also fix get().kg -> (await get()).kg
code = code.replace(/\(await get\(([\s\S]*?)\)\.kg/g, '((await get($1))?.kg ?? 0)');

// For `datetime('now', ...)` we can just use NOW()
code = code.replace(/datetime\('now'\)/g, 'NOW()');
code = code.replace(/date\('now'\)/g, 'CURRENT_DATE');

// For other dates in participations:
code = code.replace(/datetime\('now', `-\$\{Math.floor\(daysAgo\)\} days`\)/g, "NOW() - INTERVAL '${Math.floor(daysAgo)} days'");
code = code.replace(/date\('now', `-\$\{Math.floor\(daysAgo\)\} days`\)/g, "CURRENT_DATE - INTERVAL '${Math.floor(daysAgo)} days'");

fs.writeFileSync('src/seed.js', code);
console.log('Fixed seed.js');
