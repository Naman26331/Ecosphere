const fs = require('fs');
let code = fs.readFileSync('src/routes/index.js', 'utf8');

// Find all `r.get(..., (req, res) => {` and `r.post(..., (req, res) => {`
code = code.replace(/r\.(get|post)\('([^']+)',\s*\(([^)]*)\)\s*=>\s*\{/g, "r.$1('$2', async ($3) => {");
// Also handle the ones that don't have braces, e.g., `r.get(..., (req) => ...)`
code = code.replace(/r\.(get|post)\('([^']+)',\s*\(([^)]*)\)\s*=>\s*([^\{])/g, "r.$1('$2', async ($3) => $4");

fs.writeFileSync('src/routes/index.js', code);
console.log('Fixed route async signatures');
