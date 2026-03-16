const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(REPO_ROOT, 'results', 'phase1');

const TESTS = [
  {
    name: 'test-2-sonnet-4.5',
    image: path.join(REPO_ROOT, 'examples', 'test-2-invoice-card.png'),
    output: path.join(RESULTS_DIR, 'sonnet-4.5', 'test-2-output.tsx'),
    description: 'Simple Invoice Card with Claude Sonnet 4.5'
  },
  {
    name: 'test-3-sonnet-4.5',
    image: path.join(REPO_ROOT, 'examples', 'test-3-styled-invoice-card.png'),
    output: path.join(RESULTS_DIR, 'sonnet-4.5', 'test-3-output.tsx'),
    description: 'Styled Matrix Card with Claude Sonnet 4.5'
  }
];

async function runTest(browser, test, testNumber) {
  console.log('\n' + '='.repeat(80));
  console.log(`Test ${testNumber}: ${test.description}`);
  console.log('='.repeat(80));

  const context = await browser.newContext({
    acceptDownloads: true
  });
  const page = await context.newPage();

  try {
    // Navigate to the frontend
    console.log('Navigating to frontend...');
    await page.goto('http://pixel-forge.localhost:5173', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    await page.waitForTimeout(2000);

    console.log(`Uploading image: ${path.basename(test.image)}`);

    // Find and upload the image file
    const fileInput = await page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(test.image);

    await page.waitForTimeout(3000);

    // Click generate button (the tool auto-generates on upload, but let's be explicit)
    console.log('Waiting for generation to start...');
    await page.waitForTimeout(5000);

    // Wait for generation to complete
    console.log('Waiting for code generation (this may take 30-60 seconds)...');
    const maxWait = 180000;  // 3 minutes
    const startTime = Date.now();
    let generationComplete = false;

    while (Date.now() - startTime < maxWait) {
      // Look for "Download Code" button to be enabled
      const downloadButton = page.locator('button:has-text("Download Code")');
      const isVisible = await downloadButton.isVisible().catch(() => false);

      if (isVisible) {
        console.log('✅ Code generation completed!');
        generationComplete = true;
        break;
      }

      // Check every 5 seconds
      await page.waitForTimeout(5000);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`   Still generating... (${elapsed}s elapsed)`);
    }

    if (!generationComplete) {
      throw new Error('Generation timed out after 3 minutes');
    }

    // Click Download Code button and capture the download
    console.log('Downloading generated code...');

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('button:has-text("Download Code")').click();

    const download = await downloadPromise;
    const downloadPath = await download.path();

    // Read the downloaded file
    const generatedCode = fs.readFileSync(downloadPath, 'utf-8');

    // Save to our output location
    const outputDir = path.dirname(test.output);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(test.output, generatedCode);

    console.log(`✅ Code saved to: ${test.output}`);
    console.log(`   Code length: ${generatedCode.length} characters`);
    console.log(`   First 100 chars: ${generatedCode.substring(0, 100)}...`);

    return {
      success: true,
      codeLength: generatedCode.length,
      error: null
    };

  } catch (error) {
    console.log(`❌ Test failed: ${error.message}`);

    // Take screenshot for debugging
    try {
      const debugScreenshot = test.output.replace('.tsx', '-error.png');
      await page.screenshot({ path: debugScreenshot, fullPage: true });
      console.log(`   Error screenshot saved: ${debugScreenshot}`);
    } catch (e) {
      // Ignore screenshot errors
    }

    return {
      success: false,
      codeLength: 0,
      error: error.message
    };
  } finally {
    await context.close();
  }
}

async function main() {
  console.log('\n' + '#'.repeat(80));
  console.log('# Pixel Forge Automated Testing (Download Method)');
  console.log('# Testing 2 images with Claude Sonnet 4.5');
  console.log('#'.repeat(80));

  const browser = await chromium.launch({
    headless: true
  });

  const results = [];

  try {
    for (let i = 0; i < TESTS.length; i++) {
      const test = TESTS[i];

      const result = await runTest(browser, test, i + 1);
      results.push({
        test: test.name,
        description: test.description,
        image: path.basename(test.image),
        output: test.output,
        ...result
      });

      // Wait between tests
      if (i < TESTS.length - 1) {
        console.log('\nWaiting 15 seconds before next test...');
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
    }

    // Save results summary
    const summaryPath = path.join(RESULTS_DIR, 'test-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

    console.log('\n' + '#'.repeat(80));
    console.log('# All tests completed!');
    console.log(`# Summary saved to: ${summaryPath}`);
    console.log('#'.repeat(80) + '\n');

    // Print summary
    console.log('\n' + '='.repeat(80));
    console.log('TEST SUMMARY');
    console.log('='.repeat(80));

    for (const r of results) {
      const status = r.success ? '✅' : '❌';
      console.log(`\n${status} ${r.description}`);
      console.log(`   Image: ${r.image}`);
      console.log(`   Code length: ${r.codeLength} chars`);
      console.log(`   Output: ${r.output}`);
      if (r.error) {
        console.log(`   Error: ${r.error}`);
      }
    }

    console.log('\n' + '='.repeat(80));

  } finally {
    await browser.close();
  }
}

main().catch(console.error);
