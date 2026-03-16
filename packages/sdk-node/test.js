#!/usr/bin/env node
/**
 * Test SDK with example image
 */

import { generateFromFile } from './index.js';
import { writeFile } from 'fs/promises';

async function test() {
    console.log('Testing Visual to Code SDK...\n');

    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('❌ ANTHROPIC_API_KEY not set');
        process.exit(1);
    }

    const imagePath = '../../examples/test-2-invoice-card.png';

    try {
        console.log(`Generating code from: ${imagePath}`);
        const result = await generateFromFile(imagePath);

        console.log('\n✅ Success!');
        console.log(`Duration: ${result.duration}ms`);
        console.log(`Tokens: ${result.tokens.input} in, ${result.tokens.output} out`);
        console.log(`Code: ${result.code.length} chars`);

        // Save output
        await writeFile('test-output.html', result.code);
        console.log('Output saved to: test-output.html\n');

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    }
}

test();
