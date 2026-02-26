#!/bin/bash
# Generate code from UI design by delegating to Claude Code agent
# No API costs - uses your current Claude Code session

set -e

IMAGE_PATH="$1"
OUTPUT_PATH="$2"

if [ -z "$IMAGE_PATH" ]; then
    echo "Usage: ./generate_via_agent.sh <image_path> [output_path]"
    echo ""
    echo "Examples:"
    echo "  ./generate_via_agent.sh design.png"
    echo "  ./generate_via_agent.sh design.png output.html"
    exit 1
fi

if [ ! -f "$IMAGE_PATH" ]; then
    echo "Error: Image file not found: $IMAGE_PATH"
    exit 1
fi

# Default output path
if [ -z "$OUTPUT_PATH" ]; then
    OUTPUT_PATH="${IMAGE_PATH%.*}-generated.html"
fi

echo "🎨 Generating code from: $(basename $IMAGE_PATH)"
echo "📝 Output will be saved to: $OUTPUT_PATH"
echo ""
echo "This will use Claude Code's current session (no API costs)"
echo ""

# Create a prompt file that tells Claude Code what to do
PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" << EOF
Please analyze the image at: $IMAGE_PATH

Generate production-ready HTML + Tailwind CSS code for this UI design.

Requirements:
- Use Tailwind CSS utility classes via CDN
- Create semantic, accessible HTML5 markup
- Include inline SVG for icons where needed
- Make it responsive (mobile-first approach)
- Use flexbox/grid for layouts
- Add appropriate hover/focus states for interactive elements
- Include complete <html>, <head>, and <body> tags

Save the generated code to: $OUTPUT_PATH

After generating, show me a brief summary of what was created.
EOF

echo "Prompt ready. In Claude Code, you can now:"
echo "1. Read the image: $IMAGE_PATH"
echo "2. Generate the code based on the design"
echo "3. Save to: $OUTPUT_PATH"
echo ""
echo "Or simply tell Claude Code:"
echo ""
echo "  \"Generate HTML + Tailwind code from $IMAGE_PATH and save to $OUTPUT_PATH\""
echo ""

# Clean up
rm "$PROMPT_FILE"
