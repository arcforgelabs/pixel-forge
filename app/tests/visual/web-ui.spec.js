/**
 * Visual UI Tests - Phase 1 Web Interface Testing
 *
 * Tests the web UI using Playwright for visual and functional validation
 */

import { test, expect } from '@playwright/test';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test.describe('Visual to Code Web UI', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('should load homepage successfully', async ({ page }) => {
        // Check page title
        await expect(page).toHaveTitle(/Visual to Code/);

        // Check main heading
        const heading = page.locator('h1');
        await expect(heading).toHaveText('Visual to Code');

        // Check description
        await expect(page.locator('p').first()).toContainText('Upload a design image');
    });

    test('should display all main UI elements', async ({ page }) => {
        // Check upload section
        await expect(page.locator('#dropzone')).toBeVisible();
        await expect(page.locator('#imageInput')).toBeAttached();

        // Check generate button (should be disabled initially)
        const generateBtn = page.locator('#generateBtn');
        await expect(generateBtn).toBeVisible();
        await expect(generateBtn).toBeDisabled();

        // Check output placeholder
        await expect(page.locator('#placeholder')).toBeVisible();
        await expect(page.locator('#placeholder')).toContainText('Generated code will appear here');
    });

    test('should enable generate button when image is uploaded', async ({ page }) => {
        // Load test image
        const imagePath = join(__dirname, '../../../examples/test-2-invoice-card.png');

        // Upload file
        const fileInput = page.locator('#imageInput');
        await fileInput.setInputFiles(imagePath);

        // Wait for preview to appear
        await expect(page.locator('#previewSection')).toBeVisible();
        await expect(page.locator('#preview')).toBeVisible();

        // Check that generate button is enabled
        const generateBtn = page.locator('#generateBtn');
        await expect(generateBtn).toBeEnabled();
    });

    test('should show processing status when generate button is clicked', async ({ page }) => {
        // Load and upload test image
        const imagePath = join(__dirname, '../../../examples/test-2-invoice-card.png');
        await page.locator('#imageInput').setInputFiles(imagePath);

        // Wait for preview
        await expect(page.locator('#previewSection')).toBeVisible();

        // Click generate button
        const generateBtn = page.locator('#generateBtn');
        await generateBtn.click();

        // Check for status message
        const status = page.locator('#status');
        await expect(status).toBeVisible({ timeout: 2000 });
    });

    test('should display generated code after processing', async ({ page }) => {
        // Load and upload test image
        const imagePath = join(__dirname, '../../../examples/test-2-invoice-card.png');
        await page.locator('#imageInput').setInputFiles(imagePath);

        // Wait for preview
        await expect(page.locator('#previewSection')).toBeVisible();

        // Click generate button
        await page.locator('#generateBtn').click();

        // Wait for output to appear (mock mode should be fast)
        const output = page.locator('#output');
        await expect(output).toBeVisible({ timeout: 5000 });

        // Check that code is displayed
        const codeOutput = page.locator('#codeOutput');
        await expect(codeOutput).not.toBeEmpty();

        // Check that placeholder is hidden
        await expect(page.locator('#placeholder')).toBeHidden();

        // Check that copy button is visible
        await expect(page.locator('#copyBtn')).toBeVisible();
    });

    test('should verify generated code contains HTML', async ({ page }) => {
        // Load and upload test image
        const imagePath = join(__dirname, '../../../examples/test-2-invoice-card.png');
        await page.locator('#imageInput').setInputFiles(imagePath);

        // Wait and click generate
        await expect(page.locator('#previewSection')).toBeVisible();
        await page.locator('#generateBtn').click();

        // Wait for output
        await expect(page.locator('#output')).toBeVisible({ timeout: 5000 });

        // Get code content
        const codeText = await page.locator('#codeOutput').textContent();

        // Verify HTML structure
        expect(codeText).toContain('<html');
        expect(codeText).toContain('</html>');
        expect(codeText).toContain('<head');
        expect(codeText).toContain('<body');
    });

    test('should verify generated code contains Tailwind CDN', async ({ page }) => {
        // Load and upload test image
        const imagePath = join(__dirname, '../../../examples/test-2-invoice-card.png');
        await page.locator('#imageInput').setInputFiles(imagePath);

        // Wait and click generate
        await expect(page.locator('#previewSection')).toBeVisible();
        await page.locator('#generateBtn').click();

        // Wait for output
        await expect(page.locator('#output')).toBeVisible({ timeout: 5000 });

        // Get code content
        const codeText = await page.locator('#codeOutput').textContent();

        // Verify Tailwind CDN
        expect(codeText).toContain('tailwindcss.com');
    });

    test('should take full page screenshot for visual regression', async ({ page }) => {
        // Take screenshot of initial state
        await page.screenshot({ path: 'playwright-report/screenshots/homepage-initial.png', fullPage: true });

        // Upload image
        const imagePath = join(__dirname, '../../../examples/test-2-invoice-card.png');
        await page.locator('#imageInput').setInputFiles(imagePath);

        // Screenshot with preview
        await expect(page.locator('#previewSection')).toBeVisible();
        await page.screenshot({ path: 'playwright-report/screenshots/homepage-with-preview.png', fullPage: true });

        // Generate code
        await page.locator('#generateBtn').click();
        await expect(page.locator('#output')).toBeVisible({ timeout: 5000 });

        // Screenshot with generated code
        await page.screenshot({ path: 'playwright-report/screenshots/homepage-with-code.png', fullPage: true });
    });

    test('should test responsive layout on mobile', async ({ page }) => {
        // Set mobile viewport
        await page.setViewportSize({ width: 375, height: 667 });

        // Check that UI is still functional
        await expect(page.locator('h1')).toBeVisible();
        await expect(page.locator('#dropzone')).toBeVisible();
        await expect(page.locator('#generateBtn')).toBeVisible();

        // Screenshot mobile view
        await page.screenshot({ path: 'playwright-report/screenshots/homepage-mobile.png', fullPage: true });
    });

    test('should test copy button functionality', async ({ page }) => {
        // Load and upload test image
        const imagePath = join(__dirname, '../../../examples/test-2-invoice-card.png');
        await page.locator('#imageInput').setInputFiles(imagePath);

        // Generate code
        await expect(page.locator('#previewSection')).toBeVisible();
        await page.locator('#generateBtn').click();
        await expect(page.locator('#output')).toBeVisible({ timeout: 5000 });

        // Click copy button
        const copyBtn = page.locator('#copyBtn');
        await expect(copyBtn).toBeVisible();
        await copyBtn.click();

        // Give clipboard permission and verify (note: clipboard API requires user interaction in real browsers)
        // In test environment, we can only verify the button was clicked
        await expect(copyBtn).toBeEnabled();
    });
});
