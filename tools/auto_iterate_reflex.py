#!/usr/bin/env python3
"""
Automated iterative refinement using REFLEX eval scripts.

Uses the actual objective eval scripts from repos/reflex:
- Perceptual hash (blockhash) via hash.ts
- Pixel-level diff (pixelmatch) via visual.ts

Workflow:
1. Generate 4 variants
2. Eval each variant using reflex scripts (Node.js)
3. Select best variant automatically based on scores
4. Generate feedback for improvement
5. Iterate with feedback
6. Repeat until converged or max iterations

Usage:
    python auto_iterate_reflex.py <image_path> --max-iterations 3
"""

import anthropic
import base64
import sys
import os
import json
from pathlib import Path
from typing import List, Dict
import time
import subprocess
import tempfile


# System prompt from screenshot-to-code
HTML_TAILWIND_SYSTEM_PROMPT = """
You are an expert Tailwind developer
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
Do not include markdown "```" or "```html" at the start or end.
"""


def render_html_to_image_playwright(html_file: Path, output_image: Path, width: int = 1280, height: int = 720) -> bool:
    """Render HTML to PNG using Playwright."""
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': width, 'height': height})
            page.goto(f'file://{html_file.absolute()}')
            page.wait_for_timeout(2000)
            page.screenshot(path=str(output_image))
            browser.close()

        return True
    except Exception as e:
        print(f"  ❌ Playwright render error: {e}")
        return False


def evaluate_with_reflex_hash(
    original_image: Path,
    rendered_image: Path,
    reflex_dir: Path
) -> Dict:
    """
    Evaluate using reflex's perceptual hash verification.

    Calls repos/reflex hash verification directly.
    """
    try:
        # Create temp Node.js script to call reflex hash function
        eval_script = f"""
const {{ verifyHash }} = require('{reflex_dir}/dist/verification/hash.js');

async function evaluate() {{
    const result = await verifyHash(
        'variant',
        'default',
        '{rendered_image}',
        '{original_image}',
        0.9  // threshold
    );
    console.log(JSON.stringify(result));
}}

evaluate().catch(console.error);
"""

        # Run Node.js evaluation
        result = subprocess.run(
            ['node', '-e', eval_script],
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode == 0 and result.stdout:
            eval_result = json.loads(result.stdout)
            return {
                'method': 'reflex_hash',
                'verified': eval_result.get('verified', False),
                'confidence': eval_result.get('confidence', 0),
                'similarity_pct': eval_result.get('confidence', 0) * 100,
                'details': eval_result.get('details', '')
            }
        else:
            return {
                'method': 'reflex_hash',
                'verified': False,
                'confidence': 0,
                'error': result.stderr
            }

    except Exception as e:
        return {
            'method': 'reflex_hash',
            'verified': False,
            'confidence': 0,
            'error': str(e)
        }


def evaluate_with_reflex_pixelmatch(
    original_image: Path,
    rendered_image: Path,
    diff_output: Path,
    reflex_dir: Path
) -> Dict:
    """
    Evaluate using reflex's pixelmatch comparison.

    Calls repos/reflex visual comparison directly.
    """
    try:
        # Create temp Node.js script to call reflex pixelmatch
        eval_script = f"""
const {{ generateImageDiff }} = require('{reflex_dir}/dist/comparison/visual.js');

const pair = {{
    featureId: 'variant',
    featureName: 'Generated Variant',
    state: 'default',
    referencePath: '{original_image}',
    implementationPath: '{rendered_image}',
    diffPath: '{diff_output}',
    diffPixels: 0,
    diffPercent: 0
}};

const result = generateImageDiff(pair);
console.log(JSON.stringify({{
    diffPixels: result.diffPixels,
    diffPercent: result.diffPercent
}}));
"""

        result = subprocess.run(
            ['node', '-e', eval_script],
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode == 0 and result.stdout:
            eval_result = json.loads(result.stdout)
            diff_percent = eval_result.get('diffPercent', 100)
            similarity_pct = max(0, 100 - diff_percent)

            return {
                'method': 'reflex_pixelmatch',
                'diff_pixels': eval_result.get('diffPixels', 0),
                'diff_percent': diff_percent,
                'similarity_pct': similarity_pct,
                'verified': diff_percent < 5.0  # <5% diff = verified
            }
        else:
            return {
                'method': 'reflex_pixelmatch',
                'verified': False,
                'error': result.stderr
            }

    except Exception as e:
        return {
            'method': 'reflex_pixelmatch',
            'verified': False,
            'error': str(e)
        }


def evaluate_variant_reflex(
    original_image: Path,
    generated_html: Path,
    variant_num: int,
    work_dir: Path,
    reflex_dir: Path
) -> Dict:
    """
    Evaluate variant using REFLEX eval scripts.

    Returns combined score from perceptual hash + pixelmatch.
    """
    print(f"  [Variant {variant_num}] Evaluating with reflex...")

    # Render HTML to PNG
    rendered_image = work_dir / f"variant-{variant_num}-rendered.png"
    if not render_html_to_image_playwright(generated_html, rendered_image):
        return {
            'variant': variant_num,
            'error': 'Failed to render HTML',
            'overall_score': 0.0
        }

    # Eval 1: Perceptual hash (blockhash)
    hash_result = evaluate_with_reflex_hash(
        original_image,
        rendered_image,
        reflex_dir
    )

    # Eval 2: Pixel-level diff (pixelmatch)
    diff_image = work_dir / f"variant-{variant_num}-diff.png"
    pixel_result = evaluate_with_reflex_pixelmatch(
        original_image,
        rendered_image,
        diff_image,
        reflex_dir
    )

    # Combine scores (weighted: 60% perceptual, 40% pixel)
    hash_score = hash_result.get('similarity_pct', 0)
    pixel_score = pixel_result.get('similarity_pct', 0)
    overall_score = (hash_score * 0.6) + (pixel_score * 0.4)

    print(f"  [Variant {variant_num}] Hash: {hash_score:.1f}%, Pixel: {pixel_score:.1f}%, Overall: {overall_score:.1f}%")

    return {
        'variant': variant_num,
        'hash_eval': hash_result,
        'pixel_eval': pixel_result,
        'overall_score': overall_score,
        'rendered_image': str(rendered_image),
        'diff_image': str(diff_image) if diff_image.exists() else None
    }


def generate_variant(
    image_path: str,
    variant_num: int,
    model: str,
    temperature: float,
    feedback: str = None
) -> str:
    """Generate a single variant with optional feedback."""
    with open(image_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")

    ext = Path(image_path).suffix.lower()
    media_type = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
    }.get(ext, 'image/png')

    user_prompt = "Generate code for a web page that looks exactly like this."

    if feedback:
        user_prompt += f"\n\nIMPORTANT: Previous attempt scored poorly. Please improve:\n{feedback}"

    client = anthropic.Anthropic()

    response = client.messages.create(
        model=model,
        max_tokens=4096,
        temperature=temperature,
        messages=[
            {
                "role": "system",
                "content": HTML_TAILWIND_SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_data
                        }
                    },
                    {
                        "type": "text",
                        "text": user_prompt
                    }
                ]
            }
        ]
    )

    code = response.content[0].text
    if code.startswith('```'):
        lines = code.split('\n')
        lines = lines[1:]
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]
        code = '\n'.join(lines)

    return code


def auto_iterate_reflex(
    image_path: str,
    max_iterations: int = 3,
    variants_per_iteration: int = 4,
    target_score: float = 95.0,
    model: str = "claude-sonnet-4-5-20250929",
    reflex_dir: str = "/home/x-forge/repos/reflex"
):
    """
    Automated iteration using REFLEX objective eval scripts.
    """
    print(f"\n{'='*80}")
    print(f"Automated Iteration with REFLEX Evals")
    print(f"{'='*80}")
    print(f"Image: {Path(image_path).name}")
    print(f"Max iterations: {max_iterations}")
    print(f"Variants per iteration: {variants_per_iteration}")
    print(f"Target score: {target_score}%")
    print(f"Reflex dir: {reflex_dir}")
    print(f"{'='*80}\n")

    reflex_path = Path(reflex_dir)
    if not reflex_path.exists():
        print(f"Error: Reflex directory not found: {reflex_dir}")
        sys.exit(1)

    work_dir = Path("results/reflex-iterate") / Path(image_path).stem
    work_dir.mkdir(parents=True, exist_ok=True)

    original_image = Path(image_path)
    best_score = 0.0
    best_code = None
    feedback = None

    iteration_history = []

    for iteration in range(1, max_iterations + 1):
        print(f"\n{'─'*80}")
        print(f"Iteration {iteration}/{max_iterations}")
        print(f"{'─'*80}")

        temperatures = [0.7 + (i * 0.1) for i in range(variants_per_iteration)]

        # Generate variants
        variants = []
        for i in range(variants_per_iteration):
            variant_num = i + 1
            print(f"\n[Variant {variant_num}] Generating (T={temperatures[i]})...")

            code = generate_variant(
                str(image_path),
                variant_num,
                model,
                temperatures[i],
                feedback
            )

            variant_file = work_dir / f"iter{iteration}-variant{variant_num}.html"
            variant_file.write_text(code)

            print(f"[Variant {variant_num}] ✅ Generated {len(code)} chars")

            variants.append({
                'variant': variant_num,
                'code': code,
                'file': variant_file,
                'temperature': temperatures[i]
            })

        # Evaluate with reflex
        print(f"\n{'─'*40}")
        print("Evaluating with REFLEX...")
        print(f"{'─'*40}")

        evals = []
        for v in variants:
            eval_result = evaluate_variant_reflex(
                original_image,
                v['file'],
                v['variant'],
                work_dir,
                reflex_path
            )
            evals.append({**v, **eval_result})

        evals.sort(key=lambda x: x.get('overall_score', 0), reverse=True)

        iter_best = evals[0]
        print(f"\n{'─'*40}")
        print(f"Iteration {iteration} Best: Variant {iter_best['variant']} - {iter_best['overall_score']:.1f}%")
        print(f"{'─'*40}")

        if iter_best['overall_score'] > best_score:
            best_score = iter_best['overall_score']
            best_code = iter_best['code']
            print(f"✨ New best score: {best_score:.1f}%")

        iteration_history.append({
            'iteration': iteration,
            'best_score': iter_best['overall_score'],
            'variants': evals
        })

        if best_score >= target_score:
            print(f"\n🎯 Target score {target_score}% reached!")
            break

        if iteration < max_iterations:
            hash_score = iter_best.get('hash_eval', {}).get('similarity_pct', 0)
            pixel_score = iter_best.get('pixel_eval', {}).get('similarity_pct', 0)

            feedback = f"""
Previous best scored {iter_best['overall_score']:.1f}%.

Evaluation breakdown:
- Perceptual hash similarity: {hash_score:.1f}%
- Pixel-level accuracy: {pixel_score:.1f}%

Focus improvements on:
1. Exact color matching (RGB values)
2. Precise spacing (padding, margins)
3. Font sizes and weights
4. Border radius and shadows
5. Element positioning
"""
            print(f"\nℹ️  Generated feedback for iteration {iteration + 1}")

    print(f"\n{'='*80}")
    print("Final Results")
    print(f"{'='*80}")
    print(f"Best score: {best_score:.1f}%")
    print(f"Iterations: {len(iteration_history)}")

    final_file = work_dir / "best-output.html"
    final_file.write_text(best_code)
    print(f"Saved to: {final_file}")

    summary = {
        'image': str(image_path),
        'model': model,
        'best_score': best_score,
        'iterations': len(iteration_history),
        'target_score': target_score,
        'eval_method': 'reflex (perceptual_hash + pixelmatch)',
        'history': iteration_history
    }
    summary_file = work_dir / "reflex-iteration-summary.json"
    summary_file.write_text(json.dumps(summary, indent=2))
    print(f"Summary: {summary_file}")

    print(f"{'='*80}\n")

    return best_code, best_score


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description='Automated iteration with REFLEX objective evals',
        epilog="""
Reflex Eval Methods:
  - Perceptual Hash: blockhash + Hamming distance (fast, structural)
  - Pixelmatch: Pixel-level diff (precise, color-accurate)
  - Combined: 60% perceptual + 40% pixel

Examples:
  python auto_iterate_reflex.py examples/test-2-invoice-card.png
  python auto_iterate_reflex.py design.png --max-iterations 5 --target-score 98
        """
    )

    parser.add_argument('image_path', help='Original design image')
    parser.add_argument('--max-iterations', type=int, default=3)
    parser.add_argument('--variants', type=int, default=4)
    parser.add_argument('--target-score', type=float, default=95.0)
    parser.add_argument('--model', default='claude-sonnet-4-5-20250929')
    parser.add_argument('--reflex-dir', default='/home/x-forge/repos/reflex')

    args = parser.parse_args()

    if not Path(args.image_path).exists():
        print(f"Error: Image not found: {args.image_path}")
        sys.exit(1)

    # Check dependencies
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Error: Playwright not installed. Run: pip install playwright && playwright install chromium")
        sys.exit(1)

    best_code, best_score = auto_iterate_reflex(
        args.image_path,
        max_iterations=args.max_iterations,
        variants_per_iteration=args.variants,
        target_score=args.target_score,
        model=args.model,
        reflex_dir=args.reflex_dir
    )

    print(f"\n🏁 Complete! Best score: {best_score:.1f}%")


if __name__ == "__main__":
    main()
