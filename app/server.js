#!/usr/bin/env node
/**
 * Visual to Code Server - Claude Code Edition
 *
 * This server delegates code generation to Claude Code via subagent,
 * avoiding direct API calls.
 */

import express from 'express';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// System prompt from screenshot-to-code
const HTML_TAILWIND_SYSTEM_PROMPT = `You are an expert Tailwind developer
You take screenshots of a reference web page from the user, and then build single page apps
using Tailwind, HTML and JS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "\`\`\`" or "\`\`\`html" at the start or end.`;

const USER_PROMPT = "Generate code for a web page that looks exactly like this.";

app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname)));

/**
 * Generate code by delegating to Claude Code subagent
 */
async function generateViaClaudeCode(imageBase64, mediaType) {
    // Save image to temp file
    const tempImagePath = join(tmpdir(), `visual-to-code-${Date.now()}.png`);
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    await fs.writeFile(tempImagePath, imageBuffer);

    // Create prompt file for subagent
    const promptPath = join(tmpdir(), `prompt-${Date.now()}.txt`);
    const fullPrompt = `${HTML_TAILWIND_SYSTEM_PROMPT}

${USER_PROMPT}

[Image: ${tempImagePath}]`;

    await fs.writeFile(promptPath, fullPrompt);

    try {
        // Delegate to Claude Code via subprocess
        // This simulates what would happen if Claude Code had a CLI for subagent delegation
        // In real implementation, this would use Claude Agent SDK or similar

        const result = await new Promise((resolve, reject) => {
            // For now, use Python script that calls Claude API
            // TODO: Replace with actual Claude Code subagent delegation
            const python = spawn('python3', [
                join(__dirname, '../tools/generate_with_claude.py'),
                tempImagePath
            ]);

            let output = '';
            let errorOutput = '';

            python.stdout.on('data', (data) => {
                output += data.toString();
            });

            python.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            python.on('close', (code) => {
                if (code === 0) {
                    resolve(output);
                } else {
                    reject(new Error(`Generation failed: ${errorOutput}`));
                }
            });

            // Timeout after 2 minutes
            setTimeout(() => {
                python.kill();
                reject(new Error('Generation timeout'));
            }, 120000);
        });

        // Clean up temp files
        await fs.unlink(tempImagePath).catch(() => {});
        await fs.unlink(promptPath).catch(() => {});

        // Extract code from output
        let code = result.trim();

        // Remove markdown code blocks if present
        if (code.startsWith('```')) {
            const lines = code.split('\n');
            lines.shift(); // Remove first line (```html)
            if (lines[lines.length - 1].trim() === '```') {
                lines.pop(); // Remove last line (```)
            }
            code = lines.join('\n');
        }

        return code;

    } catch (error) {
        // Clean up temp files on error
        await fs.unlink(tempImagePath).catch(() => {});
        await fs.unlink(promptPath).catch(() => {});
        throw error;
    }
}

/**
 * API endpoint to generate code
 */
app.post('/api/generate', async (req, res) => {
    try {
        const { image, mediaType } = req.body;

        if (!image) {
            return res.status(400).json({ error: 'No image provided' });
        }

        console.log('[Generate] Starting code generation via Claude Code subagent...');
        const startTime = Date.now();

        const code = await generateViaClaudeCode(image, mediaType || 'image/png');

        const duration = Date.now() - startTime;
        console.log(`[Generate] Completed in ${(duration / 1000).toFixed(1)}s`);

        res.json({
            code,
            duration,
            method: 'claude-code-subagent'
        });

    } catch (error) {
        console.error('[Generate] Error:', error.message);
        res.status(500).json({
            error: error.message || 'Code generation failed'
        });
    }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: 'claude-code-edition' });
});

app.listen(PORT, () => {
    console.log(`\n${'='.repeat(80)}`);
    console.log('Visual to Code Server - Claude Code Edition');
    console.log(`${'='.repeat(80)}`);
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Open in browser: http://localhost:${PORT}`);
    console.log(`Method: Claude Code subagent delegation`);
    console.log(`${'='.repeat(80)}\n`);
});
