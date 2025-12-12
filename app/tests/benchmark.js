/**
 * Performance Baseline Benchmarking - Phase 1, Task 1.2.1.3
 *
 * Measures API performance for baseline metrics
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_URL = process.env.API_URL || 'http://visual-to-code.localhost:3001';

/**
 * Load test image as base64
 */
async function loadTestImage(filename) {
    const imagePath = join(__dirname, '../../examples', filename);
    const imageBuffer = await readFile(imagePath);
    return imageBuffer.toString('base64');
}

/**
 * Measure endpoint performance
 */
async function measureEndpoint(name, requestFn) {
    const iterations = 10;
    const times = [];

    console.log(`\nBenchmarking: ${name}`);
    console.log(`Iterations: ${iterations}`);

    for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        try {
            await requestFn();
            const duration = Date.now() - start;
            times.push(duration);
            process.stdout.write(`  ${i + 1}/${iterations}: ${duration}ms\r`);
        } catch (error) {
            console.error(`\n  Error on iteration ${i + 1}:`, error.message);
        }
    }

    console.log(); // New line after progress

    // Calculate statistics
    const sorted = times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    return {
        iterations,
        mean: Math.round(mean),
        median: Math.round(median),
        p95: Math.round(p95),
        p99: Math.round(p99),
        min: Math.round(min),
        max: Math.round(max)
    };
}

/**
 * Make HTTP request
 */
async function makeRequest(method, path, body = null) {
    const url = `${API_URL}${path}`;
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const text = await response.text();

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`Invalid JSON response from ${path}: ${text.substring(0, 100)}`);
    }
}

/**
 * Run benchmarks
 */
async function runBenchmarks() {
    console.log('='.repeat(80));
    console.log('Visual to Code - Performance Baseline Benchmark');
    console.log('='.repeat(80));

    // Load test image
    const testImage = await loadTestImage('test-2-invoice-card.png');

    const results = {};

    // Benchmark 1: Health endpoint
    results.health = await measureEndpoint('/health (GET)', async () => {
        await makeRequest('GET', '/health');
    });

    // Benchmark 2: Debug endpoint
    results.debug = await measureEndpoint('/debug (GET)', async () => {
        await makeRequest('GET', '/debug');
    });

    // Benchmark 3: Generate endpoint (mock mode)
    results.generate = await measureEndpoint('/api/generate (POST)', async () => {
        await makeRequest('POST', '/api/generate', {
            image: testImage,
            mediaType: 'image/png'
        });
    });

    // Print summary
    console.log('\n' + '='.repeat(80));
    console.log('PERFORMANCE BASELINE SUMMARY');
    console.log('='.repeat(80));

    console.log('\nMetrics (in milliseconds):');
    console.log('Endpoint'.padEnd(30), 'Mean'.padEnd(10), 'Median'.padEnd(10), 'P95'.padEnd(10), 'P99'.padEnd(10));
    console.log('-'.repeat(70));

    for (const [endpoint, stats] of Object.entries(results)) {
        console.log(
            endpoint.padEnd(30),
            stats.mean.toString().padEnd(10),
            stats.median.toString().padEnd(10),
            stats.p95.toString().padEnd(10),
            stats.p99.toString().padEnd(10)
        );
    }

    console.log('\n' + '='.repeat(80));

    // Performance assertions
    console.log('\nPerformance Checks:');

    const checks = [
        { name: 'Health endpoint < 50ms (mean)', pass: results.health.mean < 50 },
        { name: 'Debug endpoint < 50ms (mean)', pass: results.debug.mean < 50 },
        { name: 'Generate endpoint < 500ms (mean, mock mode)', pass: results.generate.mean < 500 }
    ];

    let allPassed = true;
    for (const check of checks) {
        const status = check.pass ? '✓ PASS' : '✗ FAIL';
        console.log(`  ${status}: ${check.name}`);
        if (!check.pass) allPassed = false;
    }

    console.log('\n' + '='.repeat(80));

    if (allPassed) {
        console.log('✓ All performance checks passed!');
        console.log('='.repeat(80));
        process.exit(0);
    } else {
        console.log('✗ Some performance checks failed');
        console.log('='.repeat(80));
        process.exit(1);
    }
}

// Run benchmarks
runBenchmarks().catch(error => {
    console.error('Benchmark error:', error);
    process.exit(1);
});
