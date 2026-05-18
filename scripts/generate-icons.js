const sharp = require('sharp');
const toIco = require('to-ico');
const fs = require('fs');
const path = require('path');

const SVG = path.join(__dirname, '../assets/icon.svg');
const OUT = path.join(__dirname, '../assets');

async function run() {
  const svg = fs.readFileSync(SVG);

  // Generate PNG buffers for each ICO size
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = await Promise.all(
    icoSizes.map(s => sharp(svg).resize(s, s).png().toBuffer())
  );

  // Write icon.ico
  const ico = await toIco(buffers, { sizes: icoSizes });
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
  console.log('✓ icon.ico');

  // Write icon.png (256x256) for reference
  await sharp(svg).resize(256, 256).png().toFile(path.join(OUT, 'icon.png'));
  console.log('✓ icon.png');

  console.log('Icons generated.');
}

run().catch(err => { console.error(err); process.exit(1); });
