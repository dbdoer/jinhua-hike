// 把仓库里的 SVG 渲染成各尺寸 PNG，交给 tools/build_icons.py 拼成 .ico / apple-touch-icon。
//
// 跑法：cd E:/code/jinhua-hike && node tools/render_icons.js && python tools/build_icons.py
// 需要本机有 Chrome（走 playwright 的 channel: 'chrome'）。本仓库不带 node_modules，
// playwright 装在哪儿就把哪儿喂给 NODE_PATH，例如：
//   NODE_PATH="$LOCALAPPDATA/Temp/jh-hike/node_modules" node tools/render_icons.js
//
// 两个坑写在这儿，省得下次再踩：
//   1. SVG 带着固有 width/height 时，Chrome 按那个尺寸画，视口更小就只截到左上角一块
//      —— 所以渲染前必须换成 100%。
//   2. 必须 omitBackground，否则圆角外面糊上白底。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(process.env.TEMP || '/tmp', 'jh-icons');
fs.mkdirSync(TMP, { recursive: true });

// 尺寸: 用哪份 SVG。16px 是单独重画的那份，不是把大图缩小。
const JOBS = [
  ['docs/icons/favicon-16.svg', 16, 'icon-16.png'],
  ['favicon.svg', 32, 'icon-32.png'],
  ['favicon.svg', 48, 'icon-48.png'],
  ['docs/icons/favicon-square.svg', 180, 'apple-touch-icon.png'],
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [rel, size, out] of JOBS) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/width="[\d.]+%?" height="[\d.]+%?"/, 'width="100%" height="100%"');
    if (!src.includes('width="100%"')) throw new Error(rel + ' 的宽高没换掉，截出来会是左上角');
    const fitted = path.join(TMP, 'fit-' + out.replace('.png', '.svg'));
    fs.writeFileSync(fitted, src);
    const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto('file:///' + fitted.replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(TMP, out), omitBackground: true });
    await ctx.close();
    console.log(`${out.padEnd(22)} ${size}px  ← ${rel}`);
  }
  await browser.close();
})();
