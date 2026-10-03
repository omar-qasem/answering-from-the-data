// Puts the page, its styles, the bundled engine and the UI script into one self-contained HTML file.
import fs from 'node:fs';

const engine = fs.readFileSync('engine.js', 'utf8');
const ui = fs.readFileSync('ui.js', 'utf8');
for (const [name, src] of [['engine.js', engine], ['ui.js', ui]]) {
  if (/<\/script/i.test(src) || /<!--/.test(src)) throw new Error(`${name} contains a sequence that would break an inline script`);
}
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Answer Path Explorer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap">
<style>
${fs.readFileSync('page.css', 'utf8')}</style>
</head>
<body>
${fs.readFileSync('page.body.html', 'utf8')}
<script>
${engine}</script>
<script>
${ui}</script>
</body>
</html>
`;
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/Answer-Path-Explorer.html', page);
console.log(`dist/Answer-Path-Explorer.html written (${Buffer.byteLength(page)} bytes)`);
