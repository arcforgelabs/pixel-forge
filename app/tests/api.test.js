/**
 * API Endpoint Tests - Phase 1, Task 1.1.1
 *
 * Tests for /api/generate endpoint (HTML/Tailwind generation)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test configuration
const API_URL = process.env.API_URL || 'http://visual-to-code.localhost:3001';
const TEST_TIMEOUT = 60000; // 60 seconds for LLM calls

/**
 * Load test image as base64
 */
async function loadTestImage(filename) {
    const imagePath = join(__dirname, '../../examples', filename);
    const imageBuffer = await readFile(imagePath);
    return imageBuffer.toString('base64');
}

describe('API Endpoint Tests - /api/generate', () => {
    let testImageBase64;

    beforeAll(async () => {
        // Load test image once for all tests
        testImageBase64 = await loadTestImage('test-2-invoice-card.png');
    });

    describe('Task 1.1.1: API Test Suite for HTML/Tailwind Endpoint', () => {
        it('should respond to POST /api/generate with valid image', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect('Content-Type', /json/)
                .expect(200);

            // Verify response structure
            expect(response.body).toHaveProperty('code');
            expect(response.body).toHaveProperty('duration');
            expect(response.body).toHaveProperty('method');

            // Verify code is HTML
            expect(response.body.code).toContain('<html');
            expect(response.body.code).toContain('</html>');

        }, TEST_TIMEOUT);

        it('should include Tailwind CDN in generated code', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect(200);

            expect(response.body.code).toContain('tailwindcss.com');
        }, TEST_TIMEOUT);

        it('should return valid HTML structure', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect(200);

            const code = response.body.code;

            // Check for essential HTML elements
            expect(code).toMatch(/<html/i);
            expect(code).toMatch(/<head/i);
            expect(code).toMatch(/<body/i);
            expect(code).toMatch(/<\/html>/i);
        }, TEST_TIMEOUT);

        it('should not include markdown code fences', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect(200);

            const code = response.body.code;

            // Verify no markdown fences
            expect(code).not.toContain('```html');
            expect(code).not.toContain('```');
        }, TEST_TIMEOUT);

        it('should report generation duration', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect(200);

            expect(response.body.duration).toBeGreaterThan(0);
            expect(typeof response.body.duration).toBe('number');
        }, TEST_TIMEOUT);

        it('should indicate generation method', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect(200);

            expect(response.body.method).toBeDefined();
            expect(typeof response.body.method).toBe('string');
        }, TEST_TIMEOUT);
    });

    describe('Task 1.1.2: Response Format and Structure Validation', () => {
        it('should return JSON with correct content type', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect('Content-Type', /json/)
                .expect(200);

            expect(response.body).toBeDefined();
        }, TEST_TIMEOUT);

        it('should return well-formed JSON', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect(200);

            // Verify JSON structure
            expect(response.body).toBeTypeOf('object');
            expect(Array.isArray(response.body)).toBe(false);
        }, TEST_TIMEOUT);

        it('should have code field with string content', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect(200);

            expect(typeof response.body.code).toBe('string');
            expect(response.body.code.length).toBeGreaterThan(100);
        }, TEST_TIMEOUT);

        it('should have duration field with numeric value', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect(200);

            expect(typeof response.body.duration).toBe('number');
            expect(response.body.duration).toBeGreaterThan(0);
            expect(response.body.duration).toBeLessThan(120000); // Should be < 2 minutes
        }, TEST_TIMEOUT);

        it('should generate syntactically valid HTML', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect(200);

            const code = response.body.code;

            // Basic HTML syntax validation
            const openTags = (code.match(/<html/gi) || []).length;
            const closeTags = (code.match(/<\/html>/gi) || []).length;
            expect(openTags).toBe(closeTags);

            const openHead = (code.match(/<head/gi) || []).length;
            const closeHead = (code.match(/<\/head>/gi) || []).length;
            expect(openHead).toBe(closeHead);

            const openBody = (code.match(/<body/gi) || []).length;
            const closeBody = (code.match(/<\/body>/gi) || []).length;
            expect(openBody).toBe(closeBody);
        }, TEST_TIMEOUT);
    });

    describe('Task 1.1.3: Error Handling and Edge Cases', () => {
        it('should return 400 when no image provided', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({})
                .expect('Content-Type', /json/)
                .expect(400);

            expect(response.body).toHaveProperty('error');
            expect(response.body.error).toContain('No image provided');
        });

        it('should return 400 when image field is empty', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: '',
                    mediaType: 'image/png'
                })
                .expect(400);

            expect(response.body).toHaveProperty('error');
        });

        it('should handle invalid base64 gracefully', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: 'not-valid-base64!!!',
                    mediaType: 'image/png'
                })
                .expect((res) => {
                    // Should return either 400 or 500
                    expect([400, 500]).toContain(res.status);
                });

            expect(response.body).toHaveProperty('error');
        }, TEST_TIMEOUT);

        it('should handle missing mediaType field', async () => {
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64
                    // mediaType omitted
                })
                .expect(200); // Should default to image/png

            expect(response.body.code).toBeDefined();
        }, TEST_TIMEOUT);

        it('should handle very small images', async () => {
            // Create a minimal 1x1 PNG (base64)
            const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: tinyPng,
                    mediaType: 'image/png'
                })
                .expect((res) => {
                    // Should succeed or fail gracefully
                    expect([200, 400, 500]).toContain(res.status);
                });

            if (response.status === 200) {
                expect(response.body.code).toBeDefined();
            } else {
                expect(response.body.error).toBeDefined();
            }
        }, TEST_TIMEOUT);

        it('should handle concurrent requests', async () => {
            const requests = [
                request(API_URL).post('/api/generate').send({ image: testImageBase64, mediaType: 'image/png' }),
                request(API_URL).post('/api/generate').send({ image: testImageBase64, mediaType: 'image/png' }),
                request(API_URL).post('/api/generate').send({ image: testImageBase64, mediaType: 'image/png' })
            ];

            const responses = await Promise.all(requests);

            // All should succeed
            responses.forEach(response => {
                expect(response.status).toBe(200);
                expect(response.body.code).toBeDefined();
            });
        }, TEST_TIMEOUT * 3);

        it('should respect timeout limits', async () => {
            // This test verifies the server has timeout protection
            // If generation takes > 2 minutes, should timeout
            const response = await request(API_URL)
                .post('/api/generate')
                .send({
                    image: testImageBase64,
                    mediaType: 'image/png'
                })
                .expect((res) => {
                    // Should complete within timeout or return 500
                    expect([200, 500]).toContain(res.status);
                });

            if (response.status === 500 && response.body.error) {
                expect(response.body.error.toLowerCase()).toMatch(/timeout/);
            }
        }, TEST_TIMEOUT);
    });

    describe('Health Check Endpoint', () => {
        it('should respond to GET /health', async () => {
            const response = await request(API_URL)
                .get('/health')
                .expect('Content-Type', /json/)
                .expect(200);

            expect(response.body).toHaveProperty('status');
            expect(response.body.status).toBe('ok');
        });

        it('should report version', async () => {
            const response = await request(API_URL)
                .get('/health')
                .expect(200);

            expect(response.body).toHaveProperty('version');
            expect(typeof response.body.version).toBe('string');
        });
    });
});
