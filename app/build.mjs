import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, 'dist');
const templates = path.join(__dirname, 'templates');

if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'about'), { recursive: true });
fs.mkdirSync(path.join(dist, 'static', 'img'), { recursive: true });

for (const file of ['styles.css', 'app.js', 'index.html', 'favicon.ico']) {
  fs.copyFileSync(path.join(templates, file), path.join(dist, file));
}
fs.copyFileSync(path.join(templates, 'about.html'), path.join(dist, 'about', 'index.html'));
fs.copyFileSync(path.join(templates, 'brand.svg'), path.join(dist, 'static', 'img', 'brand.svg'));

console.log(`Generated static site in ${dist}`);
