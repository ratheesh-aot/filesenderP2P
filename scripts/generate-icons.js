/**
 * Generate PWA icons for Sendee from the brand mark.
 */

const fs = require('fs');
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 192, 512];
const iconDir = path.join(__dirname, '..', 'public', 'icons');

if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true });
}

// A note on its way to a person. Same drawing at every size.
const svgTemplate = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect x="1.75" y="1.75" width="60.5" height="60.5" rx="16" fill="#1b242c" stroke="#c4552a" stroke-width="3"/>
  <path d="M11 17h16.5L36 25.5V45a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V20a3 3 0 0 1 3-3z" fill="#f7f8f9"/>
  <path d="M27.5 17V25.5H36" fill="#d5dee4"/>
  <path d="M38 23c8 1.2 12 6.2 9.5 16" fill="none" stroke="#c4552a" stroke-width="3.4" stroke-linecap="round"/>
  <circle cx="47" cy="44" r="7" fill="#c4552a"/>
  <circle cx="47" cy="44" r="2.6" fill="#f7f8f9"/>
</svg>`;

async function generateIcons() {
    for (const size of sizes) {
        const filePath = path.join(iconDir, `icon-${size}.svg`);
        fs.writeFileSync(filePath, svgTemplate(size).trim() + '\n', 'utf8');
        console.log(`Generated ${filePath}`);
    }
    console.log('Icon generation complete.');
}

generateIcons().catch(console.error);
