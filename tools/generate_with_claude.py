#!/usr/bin/env python3
"""
Generate code from UI design images using Claude API directly.
No MCP server, no browser automation - just pure API calls.

Usage:
    python generate_with_claude.py <image_path> [output_path]
"""

import anthropic
import base64
import sys
import os
from pathlib import Path


def generate_code_from_image(
    image_path: str,
    output_path: str = None,
    model: str = "claude-sonnet-4-5-20250929",
    framework: str = "html_tailwind"
) -> str:
    """
    Generate code from a UI design image using Claude API.

    Args:
        image_path: Path to the UI design image
        output_path: Optional path to save the generated code
        model: Claude model to use
        framework: Target framework (html_tailwind, react_tailwind, etc.)

    Returns:
        Generated code as string
    """
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

    # Create prompt based on framework
    framework_prompts = {
        'html_tailwind': """Generate production-ready HTML + Tailwind CSS code for this UI design.

Requirements:
- Use Tailwind CSS utility classes via CDN
- Create semantic, accessible HTML5 markup
- Include inline SVG for icons where needed
- Make it responsive (mobile-first approach)
- Use flexbox/grid for layouts
- Add appropriate hover/focus states for interactive elements
- Include complete <html>, <head>, and <body> tags
- Generate complete, working code that can be saved and opened in a browser

Output only the code, no explanations or markdown formatting.""",

        'react_tailwind': """Generate production-ready React + Tailwind CSS code for this UI design.

Requirements:
- Use React functional components
- Use Tailwind CSS utility classes
- Create semantic JSX with proper accessibility attributes
- Include inline SVG for icons where needed
- Make it responsive (mobile-first approach)
- Use flexbox/grid for layouts
- Add appropriate hover/focus states
- Export as default function

Output only the code, no explanations or markdown formatting."""
    }

    prompt = framework_prompts.get(framework, framework_prompts['html_tailwind'])

    # Initialize Anthropic client
    client = anthropic.Anthropic()

    print(f"Generating code from {Path(image_path).name}...")
    print(f"Model: {model}")
    print(f"Framework: {framework}")

    # Call Claude API
    response = client.messages.create(
        model=model,
        max_tokens=4096,
        messages=[
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
                        "text": prompt
                    }
                ]
            }
        ]
    )

    # Extract generated code
    generated_code = response.content[0].text

    # Clean up markdown code blocks if present
    if generated_code.startswith('```'):
        lines = generated_code.split('\n')
        # Remove first line (```html or similar)
        lines = lines[1:]
        # Remove last line (```)
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]
        generated_code = '\n'.join(lines)

    print(f"✅ Generated {len(generated_code)} characters of code")

    # Save if output path provided
    if output_path:
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        output_file.write_text(generated_code)
        print(f"✅ Saved to {output_path}")

    return generated_code


def main():
    if len(sys.argv) < 2:
        print("Usage: python generate_with_claude.py <image_path> [output_path]")
        print()
        print("Examples:")
        print("  python generate_with_claude.py design.png")
        print("  python generate_with_claude.py design.png output.html")
        sys.exit(1)

    image_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None

    if not Path(image_path).exists():
        print(f"Error: Image file not found: {image_path}")
        sys.exit(1)

    # Generate code
    code = generate_code_from_image(image_path, output_path)

    # Print code if no output file specified
    if not output_path:
        print("\n" + "="*80)
        print("GENERATED CODE:")
        print("="*80)
        print(code)


if __name__ == "__main__":
    main()
