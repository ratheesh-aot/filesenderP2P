/**
 * Generate PWA icons for FileSender from an inline SVG.
 * Uses the bundled Jimp (or falls back to a simple SVG file).
 */

const fs = require('fs');
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 192, 512];
const iconDir = path.join(__dirname, '..', 'public', 'icons');

// Create directory if needed
if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true });
}

// SVG source for the FileSender icon (⚡ with network lines)
const svgTemplate = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f172a;stop-opacity:1" />
      <stop offset="50%" style="stop-color:#3730a3;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0f172a;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#bg)" rx="${Math.floor(size / 6)}"/>
  <g transform="translate(${size * 0.2}, ${size * 0.15})">
    <path d="M${size * 0.6} ${size * 0.1} L${size * 0.35} ${size * 0.4} L${size * 0.6} ${size * 0.55} L${size * 0.45} ${size * 0.8}" 
          stroke="#42a4f4" stroke-width="${size / 10}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M${size * 0.3} ${size * 0.25} L${size * 0.1} ${size * 0.45} M${size * 0.9} ${size * 0.15} L${size * 0.7} ${size * 0.35}" 
          stroke="#4ade80" stroke-width="${size / 12}" stroke-linecap="round"/>
    <circle cx="${size * 0.5}" cy="${size * 0.45}" r="${size / 18}" fill="#6366f1" opacity="0.9"/>
    <path d="M${size * 0.3} ${size * 0.55} Q${size * 0.25} ${size * 0.7} ${size * 0.15} ${size * 0.6} M${size * 0.7} ${size * 0.55} Q${size * 0.75} ${size * 0.7} ${size * 0.85} ${size * 0.6}" 
          stroke="rgba(255,255,255,0.4)" stroke-width="${size / 14}" stroke-linecap="round"/>
  </g>
</svg>`;

// Generate PNG versions if Jimp is available
async function generateIcons() {
    // For now, write SVG files — they can be used as PNGs by the browser on Android PWA installs
    for (const size of sizes) {
        const svg = svgTemplate(size);
        const filePath = path.join(iconDir, `icon-${size}.svg`);
        fs.writeFileSync(filePath, svg.trim() + '\n', 'utf8');
        console.log(`Generated ${filePath}`);
    }

    // Create a minimal PNG (1px black) as placeholder for platforms requiring raster
    const placeholderPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x49, 0x48, 0x44, 0x52, 0x00,
        0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08,
        0x02, 0x00, 0x00, 0x00, 0x90, 0x7f, 0x5d, 0xb8,
        0x00, 0x00, 0x00, 0x09, 0x50, 0x4c, 0x54, 0x45,
        0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xa0, 0xbd,
        0xfe, 0x1d, 0x53, 0xc4, 0x00, 0x00, 0x00, 0x03,
        0x50, 0x4c, 0x54, 0x45, 0x00, 0x00, 0x00, 0xff,
        0xff, 0xff, 0xa0, 0xbd, 0xfe, 0x1d, 0x53, 0xc4,
        0x00, 0x00, 0x00, 0x07, 0x74, 0x52, 0x4e, 0x53,
        0x00, 0x40, 0xe6, 0xd8, 0x66, 0x40, 0x00, 0x00,
        0x00, 0x13, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c,
        0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
        0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
    ]);
    fs.writeFileSync(path.join(iconDir, 'icon-placeholder.png'), placeholderPng);

    console.log('Icon generation complete.');
}

generateIcons().catch(console.error);
