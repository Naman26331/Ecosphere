const fs = require('fs');

// --- Fix nvidia.js ---
let nvidia = fs.readFileSync('src/ai/providers/nvidia.js', 'utf8');
nvidia = nvidia.replace(/SQLite database tables/g, 'PostgreSQL database tables');
nvidia = nvidia.replace(/SQLite SELECT query/g, 'PostgreSQL SELECT query');
nvidia = nvidia.replace(/SQLite SELECT queries/g, 'PostgreSQL SELECT queries');
nvidia = nvidia.replace(/use date\('now'\)/g, 'use NOW()');
nvidia = nvidia.replace(/rows = all\(sql\)/g, 'rows = await all(sql)');
nvidia = nvidia.replace(/return rules\.askChatbot/g, 'return await rules.askChatbot');
fs.writeFileSync('src/ai/providers/nvidia.js', nvidia);


// --- Fix rules.js ---
let rules = fs.readFileSync('src/ai/providers/rules.js', 'utf8');

rules = rules.replace(/export function askChatbot\(question\)/, 'export async function askChatbot(question)');
rules = rules.replace(/return intent\.run\(q\);/, 'return await intent.run(q);');
rules = rules.replace(/function findDepartment\(q\)/, 'async function findDepartment(q)');
rules = rules.replace(/const depts = all\(`SELECT id, name, code FROM departments`\);/, 'const depts = await all(`SELECT id, name, code FROM departments`);');
rules = rules.replace(/run\(q\) \{/g, 'async run(q) {');
rules = rules.replace(/run\(\) \{/g, 'async run() {');
rules = rules.replace(/all\(/g, 'await all(');
rules = rules.replace(/get\(/g, 'await get(');
rules = rules.replace(/overall\(/g, 'await overall(');

// PostgreSQL syntax fixes in rules.js
rules = rules.replace(/date\('now'\)/g, 'NOW()');
rules = rules.replace(/date\('now', '-\$\{months\} months'\)/g, "NOW() - (months || ' months')::INTERVAL");

fs.writeFileSync('src/ai/providers/rules.js', rules);
console.log('Fixed AI providers');
