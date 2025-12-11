#!/usr/bin/env python3
"""
Automated iterative refinement using eval-driven feedback.

Workflow:
1. Generate 4 variants
2. Eval each variant automatically (pixel diff, perceptual hash)
3. Select best variant automatically
4. Generate feedback for improvement
5. Iterate with feedback
6. Repeat until converged or max iterations

No human intervention required - fully automated.

Usage:
    python auto_iterate.py <image_path> --max-iterations 3
"""

import anthropic
import base64
import sys
import os
import json
from pathlib import Path
from typing import List, Dict, Tuple
import time
import subprocess
import tempfile
from PIL import Image
import imagehash


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


def render_html_to_image(html_file: Path, output_image: Path, width: int = 1280, height: int = 720):
    """
    Render HTML file to PNG using Playwright.
    """
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': width, 'height': height})
            page.goto(f'file://{html_file.absolute()}')
            page.wait_for_timeout(2000)  # Let it render
            page.screenshot(path=str(output_image))
            browser.close()

        return True
    except Exception as e:
        print(f"  ❌ Render error: {e}")
        return False


def compute_perceptual_hash(image_path: Path) -> imagehash.ImageHash:
    """Compute perceptual hash of an image."""
    img = Image.open(image_path)
    return imagehash.phash(img)


def compute_pixel_diff(img1_path: Path, img2_path: Path) -> float:
    """
    Compute pixel-level difference percentage.
    Returns 0-100 (0 = identical, 100 = completely different)
    """
    img1 = Image.open(img1_path).convert('RGB')
    img2 = Image.open(img2_path).convert('RGB')

    # Resize to same dimensions
    if img1.size != img2.size:
        img2 = img2.resize(img1.size)

    # Convert to numpy arrays
    import numpy as np
    arr1 = np.array(img1)
    arr2 = np.array(img2)

    # Compute difference
    diff = np.abs(arr1.astype(float) - arr2.astype(float))
    max_diff = 255.0 * arr1.size
    total_diff = np.sum(diff)

    diff_percentage = (total_diff / max_diff) * 100
    return diff_percentage


def evaluate_variant(
    original_image: Path,
    generated_html: Path,
    variant_num: int,
    work_dir: Path
) -> Dict:
    """
    Evaluate a generated variant against the original image.

    Returns:
        - perceptual_similarity: 0-100 (100 = identical)
        - pixel_diff: 0-100 (0 = identical)
        - overall_score: weighted average
    """
    print(f"  [Variant {variant_num}] Evaluating...")

    # Render HTML to image
    rendered_image = work_dir / f"variant-{variant_num}-rendered.png"
    if not render_html_to_image(generated_html, rendered_image):
        return {
            'variant': variant_num,
            'error': 'Failed to render HTML',
            'score': 0.0
        }

    # Compute perceptual hash similarity
    original_hash = compute_perceptual_hash(original_image)
    rendered_hash = compute_perceptual_hash(rendered_image)
    hash_diff = original_hash - rendered_hash  # Hamming distance
    perceptual_similarity = max(0, 100 - (hash_diff / 64.0 * 100))

    # Compute pixel diff
    pixel_diff = compute_pixel_diff(original_image, rendered_image)
    pixel_similarity = 100 - pixel_diff

    # Weighted score (60% perceptual, 40% pixel)
    overall_score = (perceptual_similarity * 0.6) + (pixel_similarity * 0.4)

    print(f"  [Variant {variant_num}] Score: {overall_score:.1f}% (perceptual: {perceptual_similarity:.1f}%, pixel: {pixel_similarity:.1f}%)")

    return {
        'variant': variant_num,
        'perceptual_similarity': perceptual_similarity,
        'pixel_similarity': pixel_similarity,
        'overall_score': overall_score,
        'rendered_image': str(rendered_image)
    }


def generate_variant(
    image_path: str,
    variant_num: int,
    model: str,
    temperature: float,
    feedback: str = None
) -> str:
    """Generate a single variant, optionally with feedback for improvement."""
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
        user_prompt += f"\n\nIMPORTANT: Previous attempt had issues. Please improve:\n{feedback}"

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


def auto_iterate(
    image_path: str,
    max_iterations: int = 3,
    variants_per_iteration: int = 4,
    target_score: float = 95.0,
    model: str = "claude-sonnet-4-5-20250929"
):
    """
    Automated iterative refinement using eval-driven feedback.

    Args:
        image_path: Path to original design image
        max_iterations: Maximum number of iteration rounds
        variants_per_iteration: Number of variants per iteration
        target_score: Target accuracy score (0-100)
        model: Claude model to use

    Returns:
        Best generated code with score
    """
    print(f"\n{'='*80}")
    print(f"Automated Iterative Refinement")
    print(f"{'='*80}")
    print(f"Image: {Path(image_path).name}")
    print(f"Max iterations: {max_iterations}")
    print(f"Variants per iteration: {variants_per_iteration}")
    print(f"Target score: {target_score}%")
    print(f"Model: {model}")
    print(f"{'='*80}\n")

    # Create work directory
    work_dir = Path("results/auto-iterate") / Path(image_path).stem
    work_dir.mkdir(parents=True, exist_ok=True)

    original_image = Path(image_path)
    best_score = 0.0
    best_code = None
    best_variant = None
    feedback = None

    iteration_history = []

    for iteration in range(1, max_iterations + 1):
        print(f"\n{'─'*80}")
        print(f"Iteration {iteration}/{max_iterations}")
        print(f"{'─'*80}")

        # Temperature range for this iteration
        temperatures = [0.7 + (i * 0.1) for i in range(variants_per_iteration)]

        # Generate variants
        variants = []
        for i in range(variants_per_iteration):
            variant_num = i + 1
            print(f"\n[Variant {variant_num}] Generating (T={temperatures[i]})...")

            code = generate_variant(
                image_path,
                variant_num,
                model,
                temperatures[i],
                feedback
            )

            # Save variant
            variant_file = work_dir / f"iter{iteration}-variant{variant_num}.html"
            variant_file.write_text(code)

            print(f"[Variant {variant_num}] ✅ Generated {len(code)} chars")

            variants.append({
                'variant': variant_num,
                'code': code,
                'file': variant_file,
                'temperature': temperatures[i]
            })

        # Evaluate all variants
        print(f"\n{'─'*40}")
        print("Evaluating variants...")
        print(f"{'─'*40}")

        evals = []
        for v in variants:
            eval_result = evaluate_variant(
                original_image,
                v['file'],
                v['variant'],
                work_dir
            )
            evals.append({**v, **eval_result})

        # Sort by score
        evals.sort(key=lambda x: x.get('overall_score', 0), reverse=True)

        # Best of this iteration
        iter_best = evals[0]
        print(f"\n{'─'*40}")
        print(f"Iteration {iteration} Best: Variant {iter_best['variant']} - {iter_best['overall_score']:.1f}%")
        print(f"{'─'*40}")

        # Update global best
        if iter_best['overall_score'] > best_score:
            best_score = iter_best['overall_score']
            best_code = iter_best['code']
            best_variant = iter_best
            print(f"✨ New best score: {best_score:.1f}%")

        iteration_history.append({
            'iteration': iteration,
            'best_score': iter_best['overall_score'],
            'variants': evals
        })

        # Check if target reached
        if best_score >= target_score:
            print(f"\n🎯 Target score {target_score}% reached! (Best: {best_score:.1f}%)")
            break

        # Generate feedback for next iteration
        if iteration < max_iterations:
            # Analyze what's wrong with current best
            feedback = f"""
Previous best scored {iter_best['overall_score']:.1f}%.

Issues to fix:
- Perceptual similarity: {iter_best['perceptual_similarity']:.1f}% (need closer match)
- Pixel accuracy: {iter_best['pixel_similarity']:.1f}% (colors/spacing off)

Focus on:
1. Exact color matching (background, text, elements)
2. Precise spacing and padding
3. Font sizes and weights
4. Border radius and shadows
"""
            print(f"\nℹ️  Generated feedback for iteration {iteration + 1}")

    # Save final results
    print(f"\n{'='*80}")
    print("Final Results")
    print(f"{'='*80}")
    print(f"Best score: {best_score:.1f}%")
    print(f"Iterations: {len(iteration_history)}")

    final_file = work_dir / "best-output.html"
    final_file.write_text(best_code)
    print(f"Saved to: {final_file}")

    # Save summary
    summary = {
        'image': str(image_path),
        'model': model,
        'best_score': best_score,
        'iterations': len(iteration_history),
        'target_score': target_score,
        'history': iteration_history
    }
    summary_file = work_dir / "iteration-summary.json"
    summary_file.write_text(json.dumps(summary, indent=2))
    print(f"Summary: {summary_file}")

    print(f"{'='*80}\n")

    return best_code, best_score


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description='Automated iterative refinement with eval-driven feedback',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # 3 iterations, 4 variants each
  python auto_iterate.py examples/test-2-invoice-card.png

  # More iterations for complex designs
  python auto_iterate.py examples/test-3-styled-invoice-card.png --max-iterations 5

  # Fewer variants per iteration (faster)
  python auto_iterate.py design.png --variants 2

Workflow:
  1. Generate 4 variants (different temperatures)
  2. Render each to PNG
  3. Eval: perceptual hash + pixel diff
  4. Rank by score
  5. Generate feedback from best
  6. Iterate with feedback
  7. Repeat until target score or max iterations
        """
    )

    parser.add_argument('image_path', help='Path to original design image')
    parser.add_argument('--max-iterations', type=int, default=3, help='Max iterations (default: 3)')
    parser.add_argument('--variants', type=int, default=4, help='Variants per iteration (default: 4)')
    parser.add_argument('--target-score', type=float, default=95.0, help='Target score 0-100 (default: 95)')
    parser.add_argument('--model', default='claude-sonnet-4-5-20250929', help='Claude model')

    args = parser.parse_args()

    if not Path(args.image_path).exists():
        print(f"Error: Image not found: {args.image_path}")
        sys.exit(1)

    # Check dependencies
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Error: Playwright not installed. Install with: pip install playwright && playwright install chromium")
        sys.exit(1)

    try:
        import imagehash
        import numpy
        from PIL import Image
    except ImportError:
        print("Error: Missing dependencies. Install with: pip install imagehash numpy pillow")
        sys.exit(1)

    # Run automated iteration
    best_code, best_score = auto_iterate(
        args.image_path,
        max_iterations=args.max_iterations,
        variants_per_iteration=args.variants,
        target_score=args.target_score,
        model=args.model
    )

    print(f"\n🏁 Complete! Best score: {best_score:.1f}%")


if __name__ == "__main__":
    main()
