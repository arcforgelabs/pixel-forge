#!/usr/bin/env python3
"""
Generate multiple variants of code from a single UI design image.
Allows human selection of best variant + optional automated evaluation.

Features:
- Generate 4 variants simultaneously
- Side-by-side comparison (HTML preview)
- Human selection workflow
- Integration with reflex evals (optional)
- Iteration on selected variant

Usage:
    python generate_variants.py <image_path> --count 4
"""

import anthropic
import base64
import sys
import os
import json
from pathlib import Path
from typing import List, Dict
import time
import concurrent.futures
import webbrowser
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

USER_PROMPT = "Generate code for a web page that looks exactly like this."


def generate_single_variant(
    image_path: str,
    variant_num: int,
    model: str,
    temperature: float
) -> Dict:
    """Generate a single variant with specific temperature."""
    start_time = time.time()

    with open(image_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")

    ext = Path(image_path).suffix.lower()
    media_type = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
    }.get(ext, 'image/png')

    print(f"  [Variant {variant_num}] Generating (temperature={temperature})...")

    client = anthropic.Anthropic()

    response = client.messages.create(
        model=model,
        max_tokens=4096,
        temperature=temperature,  # Vary temperature for diversity
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

    code = response.content[0].text
    if code.startswith('```'):
        lines = code.split('\n')
        lines = lines[1:]
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]
        code = '\n'.join(lines)

    print(f"  [Variant {variant_num}] ✅ Complete in {duration:.1f}s ({len(code)} chars)")

    return {
        'variant': variant_num,
        'code': code,
        'duration': duration,
        'temperature': temperature,
        'tokens': {
            'input': response.usage.input_tokens,
            'output': response.usage.output_tokens
        }
    }


def generate_variants(
    image_path: str,
    count: int = 4,
    model: str = "claude-sonnet-4-5-20250929",
    parallel: bool = True
) -> List[Dict]:
    """
    Generate multiple variants in parallel (or sequentially).

    Args:
        image_path: Path to input image
        count: Number of variants (default 4)
        model: Claude model to use
        parallel: Generate in parallel (default True)

    Returns:
        List of variant dicts
    """
    print(f"\n{'='*80}")
    print(f"Multi-Variant Generation")
    print(f"{'='*80}")
    print(f"Image: {Path(image_path).name}")
    print(f"Variants: {count}")
    print(f"Model: {model}")
    print(f"Parallel: {parallel}")
    print(f"{'='*80}\n")

    # Vary temperature for diversity (0.7 to 1.0)
    temperatures = [0.7 + (i * 0.1) for i in range(count)]

    if parallel:
        # Generate all variants in parallel
        with concurrent.futures.ThreadPoolExecutor(max_workers=count) as executor:
            futures = [
                executor.submit(
                    generate_single_variant,
                    image_path,
                    i + 1,
                    model,
                    temperatures[i]
                )
                for i in range(count)
            ]
            variants = [f.result() for f in futures]
    else:
        # Generate sequentially (for debugging or rate limiting)
        variants = []
        for i in range(count):
            variant = generate_single_variant(
                image_path,
                i + 1,
                model,
                temperatures[i]
            )
            variants.append(variant)
            if i < count - 1:
                time.sleep(2)  # Small delay between calls

    return sorted(variants, key=lambda v: v['variant'])


def create_comparison_html(
    variants: List[Dict],
    image_path: str,
    output_path: Path
) -> Path:
    """
    Create an HTML file with side-by-side comparison of all variants.

    Returns path to comparison HTML.
    """
    # Read original image as base64
    with open(image_path, "rb") as f:
        img_data = base64.standard_b64encode(f.read()).decode()

    ext = Path(image_path).suffix.lower()
    mime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}.get(ext, 'image/png')

    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Variant Comparison - {Path(image_path).name}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }}
        .header {{
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        .header h1 {{
            font-size: 24px;
            margin-bottom: 10px;
        }}
        .header p {{
            color: #666;
            margin: 5px 0;
        }}
        .original {{
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        .original h2 {{
            font-size: 18px;
            margin-bottom: 15px;
        }}
        .original img {{
            max-width: 100%;
            border: 1px solid #ddd;
            border-radius: 4px;
        }}
        .grid {{
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
        }}
        .variant {{
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        .variant-header {{
            background: #4F46E5;
            color: white;
            padding: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }}
        .variant-header h3 {{
            font-size: 16px;
        }}
        .variant-meta {{
            font-size: 12px;
            opacity: 0.9;
        }}
        .variant-preview {{
            border: 1px solid #e5e7eb;
            background: white;
        }}
        .variant-preview iframe {{
            width: 100%;
            height: 400px;
            border: none;
        }}
        .variant-actions {{
            padding: 15px;
            display: flex;
            gap: 10px;
        }}
        button {{
            flex: 1;
            padding: 10px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }}
        .select-btn {{
            background: #10B981;
            color: white;
        }}
        .select-btn:hover {{
            background: #059669;
        }}
        .view-code-btn {{
            background: #6B7280;
            color: white;
        }}
        .view-code-btn:hover {{
            background: #4B5563;
        }}
        .modal {{
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            z-index: 1000;
        }}
        .modal-content {{
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: white;
            padding: 30px;
            border-radius: 8px;
            max-width: 90%;
            max-height: 90%;
            overflow: auto;
        }}
        .modal pre {{
            background: #1f2937;
            color: #e5e7eb;
            padding: 20px;
            border-radius: 6px;
            overflow-x: auto;
            font-size: 13px;
            line-height: 1.5;
        }}
        .close-modal {{
            position: absolute;
            top: 10px;
            right: 10px;
            background: #EF4444;
            color: white;
            border: none;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            cursor: pointer;
        }}
        @media (max-width: 1024px) {{
            .grid {{
                grid-template-columns: 1fr;
            }}
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>🎨 Variant Comparison</h1>
        <p><strong>Image:</strong> {Path(image_path).name}</p>
        <p><strong>Model:</strong> {variants[0].get('model', 'claude-sonnet-4-5-20250929')}</p>
        <p><strong>Variants:</strong> {len(variants)}</p>
    </div>

    <div class="original">
        <h2>📷 Original Design</h2>
        <img src="data:{mime};base64,{img_data}" alt="Original design" />
    </div>

    <div class="grid">
"""

    for v in variants:
        # Create separate HTML file for iframe
        variant_file = output_path / f"variant-{v['variant']}.html"
        variant_file.write_text(v['code'])

        html += f"""
        <div class="variant">
            <div class="variant-header">
                <h3>Variant {v['variant']}</h3>
                <div class="variant-meta">
                    {len(v['code'])} chars • {v['duration']:.1f}s • T={v['temperature']}
                </div>
            </div>
            <div class="variant-preview">
                <iframe src="variant-{v['variant']}.html" sandbox="allow-scripts allow-same-origin"></iframe>
            </div>
            <div class="variant-actions">
                <button class="select-btn" onclick="selectVariant({v['variant']})">
                    ✓ Select This
                </button>
                <button class="view-code-btn" onclick="viewCode({v['variant']})">
                    {'<'}/{'>'} View Code
                </button>
            </div>
        </div>
"""

    html += """
    </div>

    <!-- Code Modal -->
    <div id="codeModal" class="modal" onclick="closeModal()">
        <div class="modal-content" onclick="event.stopPropagation()">
            <button class="close-modal" onclick="closeModal()">×</button>
            <pre id="codeContent"></pre>
        </div>
    </div>

    <script>
        const variants = """ + json.dumps([{'variant': v['variant'], 'code': v['code']} for v in variants]) + """;

        function selectVariant(num) {
            const selected = variants.find(v => v.variant === num);
            console.log('Selected variant:', num);
            alert(`Selected Variant ${num}\\n\\nNext: This would save the selected variant and optionally iterate on it.`);
            // In real implementation: Save selected variant, enable iteration workflow
        }

        function viewCode(num) {
            const variant = variants.find(v => v.variant === num);
            document.getElementById('codeContent').textContent = variant.code;
            document.getElementById('codeModal').style.display = 'block';
        }

        function closeModal() {
            document.getElementById('codeModal').style.display = 'none';
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
            if (e.key >= '1' && e.key <= '4') {
                selectVariant(parseInt(e.key));
            }
        });
    </script>
</body>
</html>
"""

    comparison_file = output_path / "comparison.html"
    comparison_file.write_text(html)

    return comparison_file


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description='Generate multiple variants for comparison and selection',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate 4 variants
  python generate_variants.py examples/test-2-invoice-card.png

  # Generate 6 variants
  python generate_variants.py examples/test-2-invoice-card.png --count 6

  # Sequential generation (for debugging)
  python generate_variants.py examples/test-2-invoice-card.png --sequential

Workflow:
  1. Script generates N variants in parallel
  2. Creates comparison.html with side-by-side preview
  3. Opens in browser for human selection
  4. Selected variant can be iterated on
        """
    )

    parser.add_argument('image_path', help='Path to UI design image')
    parser.add_argument('--count', type=int, default=4, help='Number of variants (default: 4)')
    parser.add_argument('--model', default='claude-sonnet-4-5-20250929', help='Claude model')
    parser.add_argument('--sequential', action='store_true', help='Generate sequentially (not parallel)')
    parser.add_argument('--output-dir', help='Output directory (default: results/variants/<image-name>)')

    args = parser.parse_args()

    if not Path(args.image_path).exists():
        print(f"Error: Image not found: {args.image_path}")
        sys.exit(1)

    # Default output directory
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        image_name = Path(args.image_path).stem
        output_dir = Path("results/variants") / image_name

    output_dir.mkdir(parents=True, exist_ok=True)

    # Generate variants
    variants = generate_variants(
        args.image_path,
        count=args.count,
        model=args.model,
        parallel=not args.sequential
    )

    # Create comparison HTML
    print(f"\n{'='*80}")
    print("Creating comparison view...")
    comparison_file = create_comparison_html(variants, args.image_path, output_dir)
    print(f"✅ Comparison: {comparison_file}")

    # Save summary
    summary = {
        'image': str(args.image_path),
        'model': args.model,
        'count': len(variants),
        'variants': variants
    }
    summary_file = output_dir / "variants-summary.json"
    summary_file.write_text(json.dumps(summary, indent=2))
    print(f"✅ Summary: {summary_file}")

    print(f"{'='*80}\n")

    # Open in browser
    print("Opening comparison in browser...")
    webbrowser.open(str(comparison_file.absolute()))

    print("\nKeyboard shortcuts:")
    print("  1-4: Select variant")
    print("  ESC: Close modal")


if __name__ == "__main__":
    main()
