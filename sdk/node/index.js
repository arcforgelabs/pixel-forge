/**
 * Visual to Code SDK - Node.js
 *
 * Simple, reusable SDK for converting design images to HTML/Tailwind code.
 * Uses exact screenshot-to-code parameters for 85-90% visual accuracy.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import { extname } from 'path';

/**
 * System prompt from screenshot-to-code
 * This is the secret sauce for achieving high visual accuracy.
 */
export const SYSTEM_PROMPT = `You are an expert Tailwind developer
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

export const USER_PROMPT = "Generate code for a web page that looks exactly like this.";

/**
 * Default configuration
 */
export const DEFAULT_CONFIG = {
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    temperature: 1.0,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: USER_PROMPT
};

/**
 * Detect media type from file extension
 */
function getMediaType(filePath) {
    const ext = extname(filePath).toLowerCase();
    const mediaTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
    };
    return mediaTypes[ext] || 'image/png';
}

/**
 * Clean generated code (remove markdown fences if present)
 */
function cleanCode(code) {
    let cleaned = code.trim();

    if (cleaned.startsWith('```')) {
        const lines = cleaned.split('\n');
        lines.shift(); // Remove first line (```html)
        if (lines[lines.length - 1].trim() === '```') {
            lines.pop(); // Remove last line (```)
        }
        cleaned = lines.join('\n');
    }

    return cleaned;
}

/**
 * Generate code from image file
 *
 * @param {string} imagePath - Path to image file
 * @param {Object} options - Generation options
 * @param {string} options.apiKey - Anthropic API key (or use ANTHROPIC_API_KEY env var)
 * @param {string} options.model - Model to use (default: claude-sonnet-4-5-20250929)
 * @param {number} options.maxTokens - Max tokens (default: 4096)
 * @param {number} options.temperature - Temperature (default: 1.0)
 * @param {string} options.systemPrompt - Custom system prompt (optional)
 * @param {string} options.userPrompt - Custom user prompt (optional)
 * @returns {Promise<{code: string, duration: number, tokens: {input: number, output: number}}>}
 */
export async function generateFromFile(imagePath, options = {}) {
    const config = { ...DEFAULT_CONFIG, ...options };

    // Read and encode image
    const imageBuffer = await readFile(imagePath);
    const imageBase64 = imageBuffer.toString('base64');
    const mediaType = getMediaType(imagePath);

    return generateFromBase64(imageBase64, mediaType, config);
}

/**
 * Generate code from base64-encoded image
 *
 * @param {string} imageBase64 - Base64-encoded image data
 * @param {string} mediaType - Image media type (e.g., 'image/png')
 * @param {Object} options - Generation options (same as generateFromFile)
 * @returns {Promise<{code: string, duration: number, tokens: {input: number, output: number}}>}
 */
export async function generateFromBase64(imageBase64, mediaType, options = {}) {
    const config = { ...DEFAULT_CONFIG, ...options };
    const startTime = Date.now();

    // Get API key from options or environment
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not provided. Set via options.apiKey or ANTHROPIC_API_KEY env var.');
    }

    // Create Anthropic client
    const client = new Anthropic({ apiKey });

    // Generate code
    const response = await client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        system: config.systemPrompt,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: imageBase64
                        }
                    },
                    {
                        type: 'text',
                        text: config.userPrompt
                    }
                ]
            }
        ]
    });

    const duration = Date.now() - startTime;
    const code = cleanCode(response.content[0].text);

    return {
        code,
        duration,
        tokens: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens
        }
    };
}

/**
 * Generate multiple variants with different temperatures
 *
 * @param {string} imagePath - Path to image file
 * @param {Object} options - Generation options
 * @param {number} options.count - Number of variants (default: 4)
 * @param {number[]} options.temperatures - Custom temperatures (optional)
 * @param {boolean} options.parallel - Generate in parallel (default: true)
 * @returns {Promise<Array<{variant: number, code: string, duration: number, temperature: number, tokens: object}>>}
 */
export async function generateVariants(imagePath, options = {}) {
    const count = options.count || 4;
    const parallel = options.parallel !== false;

    // Temperature range: 0.7 to 1.0 by default
    const temperatures = options.temperatures ||
        Array.from({ length: count }, (_, i) => 0.7 + (i * 0.1));

    const generateVariant = async (temperature, index) => {
        const result = await generateFromFile(imagePath, {
            ...options,
            temperature
        });

        return {
            variant: index + 1,
            temperature,
            ...result
        };
    };

    if (parallel) {
        return Promise.all(
            temperatures.map((temp, i) => generateVariant(temp, i))
        );
    } else {
        const variants = [];
        for (let i = 0; i < temperatures.length; i++) {
            variants.push(await generateVariant(temperatures[i], i));
        }
        return variants;
    }
}

/**
 * Export all functions
 */
export default {
    generateFromFile,
    generateFromBase64,
    generateVariants,
    SYSTEM_PROMPT,
    USER_PROMPT,
    DEFAULT_CONFIG
};
