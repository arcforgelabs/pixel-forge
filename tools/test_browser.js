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

async function runTest(browser, test) {
  console.log('\n' + '='.repeat(80));
  console.log(`Running: ${test.description}`);
  console.log('='.repeat(80));

  const page = await browser.newPage();

  try {
    // Navigate to the frontend
    console.log('Navigating to frontend...');
    await page.goto('http://pixel-forge.localhost:5173', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Wait for the page to load
    await page.waitForTimeout(2000);

    console.log(`Uploading image: ${path.basename(test.image)}`);

    // Find and upload the image file
    const fileInput = await page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(test.image);

    // Wait for image to upload
    await page.waitForTimeout(2000);

    // Select Claude Sonnet 4.5 model (should be default)
    console.log('Selecting Claude Sonnet 4.5...');

    // Click generate button
    console.log('Clicking Generate Code button...');
    const generateButton = page.locator('button').filter({ hasText: /generate/i }).first();
    await generateButton.click();

    // Wait for generation to complete (looking for the rendered preview)
    console.log('Waiting for code generation...');
    await page.waitForTimeout(10000);  // Initial wait for generation to start

    // Keep checking for completion (max 3 minutes)
    const maxWait = 180000;  // 3 minutes
    const startTime = Date.now();
    let generationComplete = false;

    while (Date.now() - startTime < maxWait) {
      // Check if we can see "Generating:" text is gone or preview is visible
      const generatingText = await page.locator('text=Generating:').count();
      const hasPreview = await page.locator('iframe, [class*="preview"]').count() > 0;

      if (generatingText === 0 || hasPreview) {
        console.log('✅ Code generation completed!');
        generationComplete = true;
        break;
      }

      console.log('   Still generating...');
      await page.waitForTimeout(5000);
    }

    if (!generationComplete) {
      throw new Error('Generation timed out after 3 minutes');
    }

    // Click the "Code" tab to view the source code
    console.log('Switching to Code tab...');
    const codeTab = page.locator('button', { hasText: 'Code' }).or(page.locator('button:has-text("Code")')).first();

    if (await codeTab.count() > 0) {
      await codeTab.click();
      await page.waitForTimeout(2000);
    }

    // Extract the generated code
    console.log('Extracting generated code...');

    // Try multiple selectors for the code
    let generatedCode = '';

    // Try getting from code block or pre tag
    const codeElements = await page.locator('pre, code, [class*="code"], [class*="editor"]').all();
    for (const element of codeElements) {
      const text = await element.textContent();
      if (text && text.length > generatedCode.length) {
        generatedCode = text;
      }
    }

    // If still no code, try textarea
    if (!generatedCode) {
      const textarea = page.locator('textarea').first();
      if (await textarea.count() > 0) {
        generatedCode = await textarea.inputValue();
      }
    }

    if (generatedCode) {
      // Save the output
      const outputDir = path.dirname(test.output);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(test.output, generatedCode);

      console.log(`✅ Code saved to: ${test.output}`);
      console.log(`   Code length: ${generatedCode.length} characters`);

      return {
        success: true,
        codeLength: generatedCode.length,
        error: null
      };
    } else {
      console.log('❌ Could not extract generated code');

      // Take screenshot for debugging
      const debugScreenshot = test.output.replace('.tsx', '-debug.png');
      await page.screenshot({ path: debugScreenshot, fullPage: true });
      console.log(`   Debug screenshot saved: ${debugScreenshot}`);

      return {
        success: false,
        codeLength: 0,
        error: 'Could not extract generated code'
      };
    }

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
    await page.close();
  }
}

async function main() {
  console.log('\n' + '#'.repeat(80));
  console.log('# Pixel Forge Automated Browser Testing');
  console.log('# Testing 2 images with Claude Sonnet 4.5');
  console.log('#'.repeat(80));

  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (let i = 0; i < TESTS.length; i++) {
      const test = TESTS[i];
      console.log(`\nTest ${i + 1}/${TESTS.length}: ${test.description}`);

      const result = await runTest(browser, test);
      results.push({
        test: test.name,
        description: test.description,
        image: path.basename(test.image),
        output: test.output,
        ...result
      });

      // Wait between tests
      if (i < TESTS.length - 1) {
        console.log('\nWaiting 10 seconds before next test...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    // Save results summary
    const summaryPath = path.join(RESULTS_DIR, 'browser-test-summary.json');
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
