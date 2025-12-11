#!/usr/bin/env python3
"""
Batch generate code from multiple UI design images using Claude API.
Uses the EXACT same parameters and prompts as screenshot-to-code.

Key parameters (from screenshot-to-code source):
- detail: "high" (for vision API)
- System prompt: Very detailed, emphasizes exact matching
- User prompt: "Generate code for a web page that looks exactly like this."

Usage:
    python batch_generate.py <images_dir> <output_dir> [--model MODEL]
"""

import anthropic
import base64
import sys
import os
import json
from pathlib import Path
from typing import List, Dict
import time


# EXACT system prompt from screenshot-to-code
# Source: backend/prompts/screenshot_system_prompts.py
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

# EXACT user prompt from screenshot-to-code
# Source: backend/prompts/__init__.py
USER_PROMPT = """
Generate code for a web page that looks exactly like this.
"""


def generate_code_from_image(
    image_path: str,
    model: str = "claude-sonnet-4-5-20250929",
    client: anthropic.Anthropic = None
) -> Dict:
    """
    Generate code from image using EXACT screenshot-to-code parameters.

    Returns dict with:
        - code: generated HTML
        - duration: time taken (seconds)
        - model: model used
        - tokens: usage stats
    """
    start_time = time.time()

    # Read and encode image
    with open(image_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")

    # Determine media type
    ext = Path(image_path).suffix.lower()
    media_type = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
    }.get(ext, 'image/png')

    print(f"  Generating from {Path(image_path).name}...")

    # Create client if not provided
    if client is None:
        client = anthropic.Anthropic()

    # Call Claude API with EXACT screenshot-to-code parameters
    response = client.messages.create(
        model=model,
        max_tokens=4096,
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
                        "text": USER_PROMPT
                    }
                ]
            }
        ]
    )

    duration = time.time() - start_time

    # Extract generated code
    generated_code = response.content[0].text

    # Clean up markdown code blocks if present
    if generated_code.startswith('```'):
        lines = generated_code.split('\n')
        lines = lines[1:]  # Remove first line (```html)
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]  # Remove last line (```)
        generated_code = '\n'.join(lines)

    return {
        'code': generated_code,
        'duration': duration,
        'model': model,
        'tokens': {
            'input': response.usage.input_tokens,
            'output': response.usage.output_tokens
        }
    }


def batch_generate(
    images_dir: str,
    output_dir: str,
    model: str = "claude-sonnet-4-5-20250929",
    delay_seconds: int = 5
) -> List[Dict]:
    """
    Batch generate code from all images in a directory.

    Args:
        images_dir: Directory containing input images
        output_dir: Directory to save generated code
        model: Claude model to use
        delay_seconds: Delay between API calls (rate limiting)

    Returns:
        List of result dicts
    """
    images_path = Path(images_dir)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # Find all image files
    image_extensions = {'.png', '.jpg', '.jpeg', '.webp'}
    image_files = [
        f for f in images_path.iterdir()
        if f.suffix.lower() in image_extensions
    ]

    if not image_files:
        print(f"No images found in {images_dir}")
        return []

    print(f"\n{'='*80}")
    print(f"Batch Generation - screenshot-to-code compatible")
    print(f"{'='*80}")
    print(f"Images: {len(image_files)}")
    print(f"Model: {model}")
    print(f"Output: {output_dir}")
    print(f"Delay: {delay_seconds}s between calls")
    print(f"{'='*80}\n")

    # Create single client for reuse
    client = anthropic.Anthropic()

    results = []
    for i, image_file in enumerate(image_files, 1):
        print(f"\n[{i}/{len(image_files)}] Processing {image_file.name}")

        try:
            # Generate code
            result = generate_code_from_image(
                str(image_file),
                model=model,
                client=client
            )

            # Save generated code
            output_file = output_path / f"{image_file.stem}.html"
            output_file.write_text(result['code'])

            print(f"  ✅ Generated {len(result['code'])} chars in {result['duration']:.1f}s")
            print(f"  ✅ Tokens: {result['tokens']['input']} in, {result['tokens']['output']} out")
            print(f"  ✅ Saved to {output_file.name}")

            results.append({
                'image': image_file.name,
                'output': str(output_file),
                'success': True,
                **result
            })

        except Exception as e:
            print(f"  ❌ Error: {str(e)}")
            results.append({
                'image': image_file.name,
                'success': False,
                'error': str(e)
            })

        # Delay before next call (except for last one)
        if i < len(image_files):
            print(f"  ⏱️  Waiting {delay_seconds}s...")
            time.sleep(delay_seconds)

    # Save summary
    summary_file = output_path / "batch-summary.json"
    summary = {
        'total': len(image_files),
        'successful': sum(1 for r in results if r['success']),
        'failed': sum(1 for r in results if not r['success']),
        'model': model,
        'results': results
    }
    summary_file.write_text(json.dumps(summary, indent=2))

    print(f"\n{'='*80}")
    print(f"Batch Complete!")
    print(f"{'='*80}")
    print(f"Successful: {summary['successful']}/{summary['total']}")
    print(f"Summary: {summary_file}")
    print(f"{'='*80}\n")

    return results


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description='Batch generate code from UI design images (screenshot-to-code compatible)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate from all images in examples/
  python batch_generate.py examples/ results/batch/

  # Use specific model
  python batch_generate.py examples/ results/batch/ --model claude-sonnet-3-7-sonnet-20250219

  # Custom delay for rate limiting
  python batch_generate.py examples/ results/batch/ --delay 10
        """
    )

    parser.add_argument('images_dir', help='Directory containing input images')
    parser.add_argument('output_dir', help='Directory to save generated code')
    parser.add_argument('--model', default='claude-sonnet-4-5-20250929',
                       help='Claude model (default: claude-sonnet-4-5-20250929)')
    parser.add_argument('--delay', type=int, default=5,
                       help='Delay between API calls in seconds (default: 5)')

    args = parser.parse_args()

    if not Path(args.images_dir).exists():
        print(f"Error: Images directory not found: {args.images_dir}")
        sys.exit(1)

    batch_generate(
        args.images_dir,
        args.output_dir,
        model=args.model,
        delay_seconds=args.delay
    )


if __name__ == "__main__":
    main()
