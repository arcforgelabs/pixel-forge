// Screenshot tool using Playwright
const { chromium } = require('playwright');

async function takeScreenshot(htmlPath, outputPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(`file://${htmlPath}`);
  await page.screenshot({ path: outputPath, fullPage: false });

  await browser.close();
  console.log(`Screenshot saved to: ${outputPath}`);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node screenshot.js <html-path> <output-path>');
  process.exit(1);
}

takeScreenshot(args[0], args[1]).catch(console.error);
