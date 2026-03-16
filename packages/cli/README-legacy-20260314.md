# Visual to Code CLI

**Simple command-line tool for converting design images to HTML/Tailwind code**

Uses the SDK in [`../sdk-node/`](../sdk-node/) for all generation logic.

---

## Installation

```bash
cd cli
chmod +x visual-to-code
```

Or link globally:

```bash
# From project root
npm link ./cli

# Now available as command
visual-to-code --help
```

---

## Usage

### Basic Usage

```bash
# Generate code from image
./visual-to-code design.png

# Output: design.html
```

### Custom Output

```bash
./visual-to-code design.png --output result.html
```

### Batch Processing

```bash
# Process all PNG files in directory
for img in designs/*.png; do
    ./visual-to-code "$img"
done
```

---

## Requirements

- Node.js 18+
- ANTHROPIC_API_KEY environment variable

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Examples

### Single Image

```bash
./visual-to-code examples/test-2-invoice-card.png
```

**Output**:
```
================================================================================
Visual to Code CLI
================================================================================
Image: test-2-invoice-card.png
Output: test-2-invoice-card.html
================================================================================

Generating code...

================================================================================
✅ Success!
================================================================================
Duration: 8.3s
Tokens: 2891 in, 1523 out
Code: 2451 chars
Saved to: test-2-invoice-card.html
================================================================================
```

### With Custom Output

```bash
./visual-to-code design.png --output output/result.html
```

### Batch with Progress

```bash
for img in examples/*.png; do
    echo "Processing: $img"
    ./visual-to-code "$img" || echo "Failed: $img"
done
```

---

## Integration with Tools

### Python Script

```python
import subprocess

def generate_code(image_path):
    result = subprocess.run(
        ['./cli/visual-to-code', image_path],
        capture_output=True,
        text=True,
        check=True
    )
    return result.returncode == 0

generate_code('design.png')
```

### Shell Script

```bash
#!/bin/bash
# batch-process.sh

IMAGES_DIR="$1"
OUTPUT_DIR="$2"

mkdir -p "$OUTPUT_DIR"

for img in "$IMAGES_DIR"/*.png; do
    filename=$(basename "$img" .png)
    ./cli/visual-to-code "$img" --output "$OUTPUT_DIR/$filename.html"
done
```

---

## Error Handling

### Missing API Key

```bash
$ ./visual-to-code design.png

================================================================================
❌ Error
================================================================================
ANTHROPIC_API_KEY not provided. Set via ANTHROPIC_API_KEY env var.
================================================================================

Set your API key: export ANTHROPIC_API_KEY="sk-ant-..."
```

### Invalid Image

```bash
$ ./visual-to-code nonexistent.png

================================================================================
❌ Error
================================================================================
ENOENT: no such file or directory
================================================================================
```

---

## Architecture

The CLI is a thin wrapper around the SDK:

```
visual-to-code (CLI)
    └─> @visual-to-code/sdk
        └─> @anthropic-ai/sdk
            └─> Claude API
```

**Benefits**:
- Simple, focused CLI
- All logic in SDK (reusable)
- Easy to test
- Can add more features without changing CLI

---

## Comparison with Web App

| Feature | CLI | Web App |
|---------|-----|---------|
| **Interface** | Command line | Browser |
| **Input** | File path | Drag & drop |
| **Output** | Write file | Display + copy |
| **Automation** | ✅ Yes | ❌ No |
| **Batch** | ✅ Easy | ❌ Manual |
| **Subagents** | ✅ Yes | ❌ No |
| **Interactive** | ❌ No | ✅ Yes |

**Use CLI for**: Automation, batch processing, subagent workflows
**Use Web App for**: Interactive use, visual feedback, one-off generation

---

## Development

### Local Testing

```bash
# Test with example
./visual-to-code ../examples/test-2-invoice-card.png

# Test with custom output
./visual-to-code ../examples/test-3-styled-invoice-card.png --output test-output.html
```

### Debugging

```bash
# Enable Node.js debugging
NODE_OPTIONS='--inspect' ./visual-to-code design.png

# Verbose error output
DEBUG=* ./visual-to-code design.png
```

---

## Future Enhancements

1. **Streaming output** - Show generation progress
2. **Batch mode flag** - `--batch designs/*.png`
3. **Quality presets** - `--quality fast|balanced|best`
4. **Template selection** - `--template minimal|full`
5. **Reflex integration** - `--eval` to score output
6. **Watch mode** - `--watch` to regenerate on changes

---

## License

MIT
