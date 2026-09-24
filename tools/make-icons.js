// Generates the web app's PNG icons and the link-preview card, by drawing
// them as SVG/HTML in Chromium and taking screenshots. The outputs are
// committed, so this only needs running again when the artwork changes:
//
//   NODE_PATH=$(npm root -g) node tools/make-icons.js
//   CHROMIUM_PATH=/path/to/chrome NODE_PATH=$(npm root -g) node tools/make-icons.js
//
// Playwright is the only thing it needs, installed outside the app like the
// browser suites' (see tests/README.md) — the site itself stays dependency
// free and never runs this.
//
// Writes, under frontend/:
//   icons/icon-192.png, icons/icon-512.png   manifest "any": the favicon,
//                                            corners and all
//   icons/icon-maskable-512.png              manifest "maskable": full bleed,
//                                            the mark inside the safe zone
//   icons/apple-touch-icon.png               180x180, full bleed (iOS rounds
//                                            the corners itself and fills
//                                            transparency with black)
//   icons/shortcut-new-96.png                the two manifest shortcuts
//   icons/shortcut-import-96.png
//   social-card.png                          1200x630 Open Graph image

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const ICONS = path.join(FRONTEND, 'icons');

// The favicon's colours and geometry (frontend/favicon.svg, a 32-unit box):
// a dark tile with a three-node tree in the identity blue.
const TILE = '#0a0f1c';
const MARK = '#60a5fa';
const MARK_SHAPES = `
  <line x1="16" y1="9" x2="9" y2="22" stroke="${MARK}" stroke-width="2" stroke-linecap="round"/>
  <line x1="16" y1="9" x2="23" y2="22" stroke="${MARK}" stroke-width="2" stroke-linecap="round"/>
  <circle cx="16" cy="9" r="3.5" fill="${MARK}"/>
  <circle cx="9" cy="22" r="3" fill="${MARK}"/>
  <circle cx="23" cy="22" r="3" fill="${MARK}"/>`;
// The mark spans x 6..26 and y 5.5..25, so its centre is (16, 15.25).
const MARK_CENTRE_Y = 15.25;

// The mark scaled about its own centre and put in the middle of the tile.
function centredMark(scale) {
  return `<g transform="translate(16 16) scale(${scale}) translate(-16 -${MARK_CENTRE_Y})">${MARK_SHAPES}</g>`;
}

function svg(size, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">${inner}</svg>`;
}

// "any": exactly the favicon, rounded corners transparent.
const anyIcon = (size) => svg(size, `<rect width="32" height="32" rx="7" fill="${TILE}"/>${MARK_SHAPES}`);

// "maskable" (W3C Web App Manifest, icon masks): the platform crops the
// icon to its own shape, keeping at least the central circle of radius 40%
// — 12.8 units here. At scale 1 the mark's farthest point (the edge of a
// lower node) is 12.7 units from the centre, which would touch the circle,
// so it is drawn at 0.8 and the tile runs to every edge.
const maskableIcon = (size) => svg(size, `<rect width="32" height="32" fill="${TILE}"/>${centredMark(0.8)}`);

// iOS applies its own rounded mask, a little tighter than a circle's corners
// but far looser than the maskable safe zone.
const appleIcon = (size) => svg(size, `<rect width="32" height="32" fill="${TILE}"/>${centredMark(0.9)}`);

// Shortcut icons: the same tile, with what the shortcut does.
const shortcutNew = (size) =>
  svg(
    size,
    `<rect width="32" height="32" rx="7" fill="${TILE}"/>
     <path d="M16 9v14M9 16h14" stroke="${MARK}" stroke-width="2.5" stroke-linecap="round"/>`
  );
const shortcutImport = (size) =>
  svg(
    size,
    `<rect width="32" height="32" rx="7" fill="${TILE}"/>
     <path d="M16 8v11M11.5 14.5 16 19l4.5-4.5M9 20v3h14v-3" fill="none" stroke="${MARK}"
       stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
  );

// ---------- the social card ----------

// Drawn in the site's own light palette and type (style.css), with a small
// graph in the style of the tree page: white nodes, blue "start here" ones,
// grey links curving between columns.
function socialCardHtml() {
  const font = fs.readFileSync(path.join(FRONTEND, 'fonts', 'inter-latin.woff2')).toString('base64');
  const W = 190;
  const H = 62;
  const nodes = {
    measure: { x: 70, y: 350, name: 'Measure ingredients', sub: '✦ Start here', start: true },
    starter: { x: 70, y: 470, name: 'Keep a starter', sub: '✦ Start here', start: true },
    knead: { x: 350, y: 350, name: 'Knead dough', sub: 'Needs 1 · Unlocks 1' },
    ferment: { x: 630, y: 410, name: 'Bulk fermentation', sub: 'Needs 2 · Unlocks 1' },
    bake: { x: 910, y: 410, name: 'Bake a loaf', sub: 'Needs 1 · Unlocks 0' },
  };
  const edges = [
    ['measure', 'knead'],
    ['knead', 'ferment'],
    ['starter', 'ferment'],
    ['ferment', 'bake'],
  ];
  // The same curve as edgeCurve() in layout.js: control points reach half
  // the horizontal run, floored at 36.
  const edgePaths = edges
    .map(([a, b]) => {
      const x1 = nodes[a].x + W;
      const y1 = nodes[a].y + H / 2;
      const x2 = nodes[b].x - 4;
      const y2 = nodes[b].y + H / 2;
      const reach = Math.min(Math.max((x2 - x1) / 2, 36), x2 - x1);
      return `<path d="M${x1} ${y1} C${x1 + reach} ${y1} ${x2 - reach} ${y2} ${x2} ${y2}" fill="none"
        stroke="#7c8ba1" stroke-width="2" marker-end="url(#arrow)"/>`;
    })
    .join('');
  const nodeShapes = Object.values(nodes)
    .map(
      (n) => `
      <g transform="translate(${n.x} ${n.y})">
        <rect width="${W}" height="${H}" rx="9" fill="#ffffff" stroke="${n.start ? '#2563eb' : '#7c8ba1'}"
          stroke-width="${n.start ? 2.5 : 2}"/>
        <text x="16" y="27" font-size="17" font-weight="600" fill="#0f172a">${n.name}</text>
        <text x="16" y="47" font-size="13" fill="#51617a">${n.sub}</text>
      </g>`
    )
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  @font-face { font-family: 'Inter'; font-weight: 400 700; src: url(data:font/woff2;base64,${font}) format('woff2'); }
  html, body { margin: 0; }
  body {
    width: 1200px; height: 630px; overflow: hidden; position: relative;
    font-family: 'Inter', sans-serif; color: #0f172a;
    background-color: #f6f8fa;
    background-image: radial-gradient(rgba(15, 23, 42, 0.12) 1.4px, transparent 1.6px);
    background-size: 28px 28px;
  }
  .head { position: absolute; left: 70px; top: 64px; right: 70px; }
  .brand { display: flex; align-items: center; gap: 22px; }
  .brand svg { width: 76px; height: 76px; flex: none; }
  h1 { margin: 0; font-size: 80px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
  .rule { width: 72px; height: 6px; border-radius: 3px; background: #2563eb; margin: 26px 0 22px; }
  p { margin: 0; font-size: 30px; line-height: 1.35; color: #51617a; max-width: 900px; }
  svg.graph { position: absolute; left: 0; top: 0; }
</style></head>
<body>
  <div class="head">
    <div class="brand">${svg(76, `<rect width="32" height="32" rx="7" fill="${TILE}"/>${MARK_SHAPES}`)}<h1>Skill Trees</h1></div>
    <div class="rule"></div>
    <p>Maps of how learning one skill makes you ready for the next.</p>
  </div>
  <svg class="graph" width="1200" height="630" viewBox="0 0 1200 630" font-family="Inter, sans-serif">
    <defs>
      <marker id="arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
        <polygon points="0 0.5, 8.5 4.5, 0 8.5" fill="#7c8ba1"/>
      </marker>
    </defs>
    ${edgePaths}
    ${nodeShapes}
  </svg>
</body></html>`;
}

(async () => {
  fs.mkdirSync(ICONS, { recursive: true });
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  const shoot = async (file, width, height, html, { transparent = false } = {}) => {
    await page.setViewportSize({ width, height });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
    console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${width}x${height})`);
  };
  const iconPage = (markup) => `<!DOCTYPE html><html><body style="margin:0">${markup}</body></html>`;

  for (const size of [192, 512]) {
    await shoot(path.join(ICONS, `icon-${size}.png`), size, size, iconPage(anyIcon(size)), { transparent: true });
  }
  await shoot(path.join(ICONS, 'icon-maskable-512.png'), 512, 512, iconPage(maskableIcon(512)));
  await shoot(path.join(ICONS, 'apple-touch-icon.png'), 180, 180, iconPage(appleIcon(180)));
  await shoot(path.join(ICONS, 'shortcut-new-96.png'), 96, 96, iconPage(shortcutNew(96)), { transparent: true });
  await shoot(path.join(ICONS, 'shortcut-import-96.png'), 96, 96, iconPage(shortcutImport(96)), {
    transparent: true,
  });
  await shoot(path.join(FRONTEND, 'social-card.png'), 1200, 630, socialCardHtml());

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
