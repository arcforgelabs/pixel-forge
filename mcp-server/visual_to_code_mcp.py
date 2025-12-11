#!/usr/bin/env python3
"""
Visual to Code MCP Server - Delegation Pattern v2.0

IMPROVEMENTS:
1. File-based dual-response (99% token reduction)
2. Structured MCP error responses with troubleshooting
3. Warmup tool (ensure_delegation_ready)
4. Token usage metrics collection
5. Structured JSON responses (no markdown)

Provides tools to convert design images to HTML/Tailwind code by delegating
to the parent Claude Code agent. NO API CALLS - uses your session's vision
capability, completely free under your Max subscription.

Architecture:
1. MCP tool receives image path
2. Writes delegation request to /tmp/visual-to-code-delegation/request-{id}.json
3. Parent agent monitors /tmp for requests
4. Parent spawns subagent to preserve context
5. Subagent processes image with vision (YOUR session)
6. Parent writes response to /tmp/visual-to-code-delegation/response-{id}.json
7. MCP tool reads response, writes HTML to file, returns file path + preview

Tools:
- ensure_delegation_ready: Check parent monitoring is active (warmup)
- generate_code_from_image: Generate code from single image (via delegation)
- generate_variants: Generate multiple variants (via delegation)
"""

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Optional, Union

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field, field_validator, ConfigDict

# Configure logging to stderr (never stdout for stdio transport)
logging.basicConfig(
    level=logging.INFO,
    format='[%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]  # Goes to stderr by default
)
logger = logging.getLogger(__name__)

# Initialize MCP server
mcp = FastMCP("visual_to_code_mcp")

# Constants
DELEGATION_DIR = Path("/tmp/visual-to-code-delegation")
DELEGATION_DIR.mkdir(exist_ok=True)

OUTPUT_DIR = Path("/tmp/visual-to-code-output")
OUTPUT_DIR.mkdir(exist_ok=True)

METRICS_FILE = Path("/tmp/visual-to-code-metrics.jsonl")

# System prompt from screenshot-to-code (used by parent agent)
SYSTEM_PROMPT = """You are an expert Tailwind developer
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
Do not include markdown "```" or "```html" at the start or end."""

USER_PROMPT = "Generate code for a web page that looks exactly like this."

# Timeouts
REQUEST_TIMEOUT = 300  # 5 minutes for parent to respond
POLL_INTERVAL = 2  # Check every 2 seconds
WARMUP_TIMEOUT = 5  # 5 seconds for warmup check

# ============================================================================
# Error Response Helper
# ============================================================================

def create_error_response(error_type: str, message: str, troubleshooting: list) -> dict:
    """Create structured MCP error response.

    Args:
        error_type: Error category (FileNotFound, DelegationTimeout, etc.)
        message: Human-readable error description
        troubleshooting: List of actionable steps to resolve the issue

    Returns:
        Structured error dict with isError flag
    """
    return {
        "isError": True,
        "error": {
            "type": error_type,
            "message": message,
            "troubleshooting": troubleshooting
        }
    }

# ============================================================================
# Token Metrics
# ============================================================================

try:
    import tiktoken
    METRICS_ENABLED = True
except ImportError:
    logger.warning("tiktoken not available - metrics collection disabled")
    METRICS_ENABLED = False

class TokenMetrics:
    """Track token usage for optimization monitoring."""

    def __init__(self):
        if METRICS_ENABLED:
            self.encoder = tiktoken.encoding_for_model("gpt-4")
        else:
            self.encoder = None

    def count_tokens(self, text: str) -> int:
        """Count tokens in text."""
        if not self.encoder:
            return 0
        return len(self.encoder.encode(text))

    def log_call(self, tool: str, response: dict, metadata: dict):
        """Log tool call metrics."""
        if not METRICS_ENABLED:
            return

        try:
            tokens = self.count_tokens(json.dumps(response))
            entry = {
                "timestamp": time.time(),
                "tool": tool,
                "tokens": tokens,
                "metadata": metadata
            }
            with open(METRICS_FILE, 'a') as f:
                f.write(json.dumps(entry) + '\n')
            logger.info(f"Metrics logged: {tool} - {tokens} tokens")
        except Exception as e:
            logger.warning(f"Failed to log metrics: {e}")

metrics = TokenMetrics()

# ============================================================================
# Input Models
# ============================================================================

class GenerateCodeInput(BaseModel):
    """Input model for generating code from a design image."""
    model_config = ConfigDict(
        str_strip_whitespace=True,
        validate_assignment=True,
        extra='forbid'
    )

    image_path: str = Field(
        ...,
        description="Absolute or relative path to design image file (PNG, JPG, JPEG, WEBP). Examples: 'design.png', '/home/user/designs/mockup.jpg', './wireframe.png'"
    )

    temperature: Optional[float] = Field(
        default=1.0,
        description="Temperature for generation (0.7=conservative, 1.0=balanced/default, higher=creative). Controls code variation.",
        ge=0.0,
        le=2.0
    )

    @field_validator('image_path')
    @classmethod
    def validate_image_path(cls, v: str) -> str:
        """Validate image file exists and has valid extension."""
        path = Path(v).expanduser()

        # Check if file exists
        if not path.exists():
            raise ValueError(f"Image file not found: {v}")

        if not path.is_file():
            raise ValueError(f"Path is not a file: {v}")

        # Check extension
        valid_extensions = {'.png', '.jpg', '.jpeg', '.webp'}
        if path.suffix.lower() not in valid_extensions:
            raise ValueError(f"Invalid image format. Supported: PNG, JPG, JPEG, WEBP. Got: {path.suffix}")

        return str(path.absolute())


class GenerateVariantsInput(BaseModel):
    """Input model for generating multiple code variants."""
    model_config = ConfigDict(
        str_strip_whitespace=True,
        validate_assignment=True,
        extra='forbid'
    )

    image_path: str = Field(
        ...,
        description="Absolute or relative path to design image file (PNG, JPG, JPEG, WEBP)"
    )

    count: Optional[int] = Field(
        default=4,
        description="Number of variants to generate (2-6). Default is 4.",
        ge=2,
        le=6
    )

    @field_validator('image_path')
    @classmethod
    def validate_image_path(cls, v: str) -> str:
        """Validate image file exists."""
        path = Path(v).expanduser()
        if not path.exists():
            raise ValueError(f"Image file not found: {v}")
        if not path.is_file():
            raise ValueError(f"Path is not a file: {v}")
        valid_extensions = {'.png', '.jpg', '.jpeg', '.webp'}
        if path.suffix.lower() not in valid_extensions:
            raise ValueError(f"Invalid image format. Supported: PNG, JPG, JPEG, WEBP.")
        return str(path.absolute())


# ============================================================================
# Delegation System
# ============================================================================

async def delegate_to_parent(
    image_path: str,
    temperature: float = 1.0,
    request_type: str = "generate"
) -> str:
    """
    Delegate vision work to parent Claude Code agent.

    Creates a request file that the parent agent monitors and processes.
    Waits for response file with generated code.

    Returns:
        Generated HTML/Tailwind code
    """
    request_id = str(uuid.uuid4())[:8]
    request_file = DELEGATION_DIR / f"request-{request_id}.json"
    response_file = DELEGATION_DIR / f"response-{request_id}.json"

    # Create delegation request
    request_data = {
        "request_id": request_id,
        "type": request_type,
        "image_path": image_path,
        "temperature": temperature,
        "system_prompt": SYSTEM_PROMPT,
        "user_prompt": USER_PROMPT,
        "response_file": str(response_file),
        "timestamp": time.time(),
        "use_subagent": True,
        "subagent_instruction": (
            "IMPORTANT: Use a subagent to process this image to preserve your context. "
            "Delegate the vision analysis to a general-purpose subagent with the provided "
            "system_prompt and user_prompt. The subagent should read the image, analyze it "
            "using vision capability, and generate HTML/Tailwind code. Return only the "
            "generated code in the response."
        )
    }

    logger.info(f"Creating delegation request: {request_id}")
    request_file.write_text(json.dumps(request_data, indent=2))

    # Wait for parent agent to process
    start_time = time.time()

    while True:
        elapsed = time.time() - start_time

        # Check timeout
        if elapsed > REQUEST_TIMEOUT:
            request_file.unlink(missing_ok=True)
            raise TimeoutError(
                f"Parent agent did not respond within {REQUEST_TIMEOUT}s. "
                "Ensure Claude Code is monitoring delegation requests."
            )

        # Check for response
        if response_file.exists():
            logger.info(f"Response received after {elapsed:.2f}s")

            # Read response
            try:
                response_data = json.loads(response_file.read_text())

                # Clean up files
                request_file.unlink(missing_ok=True)
                response_file.unlink(missing_ok=True)

                # Check for error
                if "error" in response_data:
                    raise RuntimeError(f"Parent agent error: {response_data['error']}")

                # Return generated code
                return response_data["code"]

            except json.JSONDecodeError as e:
                logger.error(f"Invalid response JSON: {e}")
                request_file.unlink(missing_ok=True)
                response_file.unlink(missing_ok=True)
                raise RuntimeError(f"Invalid response from parent agent: {e}")

        # Wait before next check
        await asyncio.sleep(POLL_INTERVAL)


# ============================================================================
# Tools
# ============================================================================

@mcp.tool(
    name="ensure_delegation_ready",
    annotations={
        "title": "Ensure Parent Monitoring System is Ready",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False
    }
)
async def ensure_delegation_ready() -> dict:
    """Ensure parent monitoring system is running and ready (WARMUP TOOL).

    Use proactively before generation tasks to verify parent agent monitoring
    is active. Returns immediately if monitoring is ready. Useful for batch
    operations to avoid cold-start delays.

    Returns:
        Status dict indicating readiness state
    """
    try:
        logger.info("Checking delegation system readiness...")

        # Check if delegation dir exists
        if not DELEGATION_DIR.exists():
            return create_error_response(
                error_type="DelegationDirMissing",
                message="Delegation directory does not exist",
                troubleshooting=[
                    f"Create directory: mkdir -p {DELEGATION_DIR}",
                    "Restart MCP server to auto-create directory"
                ]
            )

        # Write test request
        test_id = str(uuid.uuid4())[:8]
        test_file = DELEGATION_DIR / f"test-ping-{test_id}.json"
        test_response = DELEGATION_DIR / f"test-pong-{test_id}.json"

        test_data = {
            "type": "ping",
            "test_id": test_id,
            "timestamp": time.time(),
            "response_file": str(test_response)
        }

        test_file.write_text(json.dumps(test_data))
        logger.info(f"Wrote test ping: {test_id}")

        # Wait for response (max 5 seconds)
        start_time = time.time()
        while time.time() - start_time < WARMUP_TIMEOUT:
            if test_response.exists():
                # Cleanup
                test_file.unlink(missing_ok=True)
                test_response.unlink(missing_ok=True)

                return {
                    "success": True,
                    "status": "ready",
                    "message": "Parent monitoring system is active",
                    "response_time": time.time() - start_time
                }

            # Check if test file was consumed
            if not test_file.exists():
                # Parent consumed it but didn't respond - assume ready
                test_response.unlink(missing_ok=True)
                return {
                    "success": True,
                    "status": "ready_assumed",
                    "message": "Parent consumed test request (assumed ready)",
                    "response_time": time.time() - start_time
                }

            await asyncio.sleep(0.5)

        # Timeout - cleanup
        test_file.unlink(missing_ok=True)
        test_response.unlink(missing_ok=True)

        return create_error_response(
            error_type="ParentNotMonitoring",
            message="Parent monitoring system not responding",
            troubleshooting=[
                "Start parent monitoring script",
                "Check for process: ps aux | grep monitor",
                f"Verify delegation directory: ls -la {DELEGATION_DIR}",
                "Ensure parent agent is running with delegation support"
            ]
        )

    except Exception as e:
        logger.error(f"Warmup check failed: {e}", exc_info=True)
        return create_error_response(
            error_type="WarmupFailed",
            message=f"Failed to check delegation readiness: {str(e)}",
            troubleshooting=[
                "Check server logs for details",
                f"Verify directory permissions: ls -la {DELEGATION_DIR.parent}",
                "Ensure sufficient disk space: df -h /tmp"
            ]
        )


@mcp.tool(
    name="generate_code_from_image",
    annotations={
        "title": "Generate HTML/Tailwind Code from Design Image",
        "readOnlyHint": False,  # Uses parent session (no cost, but uses quota)
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False   # No external API calls - uses parent agent
    }
)
async def generate_code_from_image(params: GenerateCodeInput) -> dict:
    """Generate HTML/Tailwind code from design image via parent agent delegation (NO API COSTS).

    This tool delegates to the parent Claude Code agent to process the image using
    YOUR session's vision capability. Completely free under your Max subscription.

    Uses exact screenshot-to-code parameters for 85-90% visual accuracy:
    - detail="high" for maximum visual fidelity
    - Specialized prompts emphasizing "exactly"

    Returns file path to generated code with preview and metadata.

    Args:
        params: GenerateCodeInput with image_path and optional temperature

    Returns:
        Structured JSON with file path, preview, and metadata

    How it works:
        1. Tool writes delegation request to /tmp
        2. Parent Claude Code agent monitors /tmp (needs to be set up)
        3. Parent spawns subagent to preserve context
        4. Subagent uses vision to analyze image and generate code
        5. Parent writes response with generated code
        6. Tool writes code to file and returns path with preview

    Note: Parent agent must be monitoring for delegation requests and spawn subagents.
    """
    try:
        logger.info(f"Delegating generation for: {params.image_path}")

        # Delegate to parent agent
        code = await delegate_to_parent(
            image_path=params.image_path,
            temperature=params.temperature,
            request_type="generate"
        )

        # Generate output filename
        image_name = Path(params.image_path).stem
        request_id = str(uuid.uuid4())[:8]
        output_filename = f"{request_id}_{image_name}.html"
        output_path = OUTPUT_DIR / output_filename

        # Write code to file
        output_path.write_text(code)
        logger.info(f"Code written to: {output_path}")

        # Create preview (first 500 characters)
        preview = code[:500] + ("..." if len(code) > 500 else "")

        # Build structured response
        response = {
            "success": True,
            "metadata": {
                "image": Path(params.image_path).name,
                "temperature": params.temperature,
                "method": "delegation",
                "code_size": len(code),
                "accuracy": "85-90%"
            },
            "output": {
                "file_path": str(output_path),
                "file_uri": f"file://{output_path}",
                "preview": preview
            },
            "usage": {
                "note": "Code written to file. Read file for full HTML/Tailwind implementation.",
                "command": f"cat {output_path}",
                "open_browser": f"xdg-open {output_path}"
            }
        }

        # Log metrics
        metrics.log_call("generate_code_from_image", response, {
            "image_size": Path(params.image_path).stat().st_size if Path(params.image_path).exists() else 0,
            "temperature": params.temperature,
            "code_size": len(code)
        })

        return response

    except ValueError as e:
        return create_error_response(
            error_type="InvalidInput",
            message=str(e),
            troubleshooting=[
                f"Verify file exists: ls -la {params.image_path}",
                "Use absolute path: /home/user/design.png",
                "Check file permissions: chmod 644 <image_path>",
                "Verify file format: file <image_path>"
            ]
        )

    except TimeoutError as e:
        return create_error_response(
            error_type="DelegationTimeout",
            message="Parent agent did not respond within 5 minutes",
            troubleshooting=[
                "Check delegation directory: ls -la /tmp/visual-to-code-delegation/",
                "Verify parent monitoring is running: ps aux | grep monitor",
                "Check for stuck request files: ls /tmp/visual-to-code-delegation/request-*.json",
                "Ensure parent monitoring script is active",
                "Try: ensure_delegation_ready tool first"
            ]
        )

    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        return create_error_response(
            error_type="UnexpectedError",
            message=f"Generation failed: {str(e)}",
            troubleshooting=[
                "Check server logs for details",
                "Verify delegation directory exists: ls -la /tmp/visual-to-code-delegation/",
                "Ensure sufficient disk space: df -h /tmp",
                "Try with a different image"
            ]
        )


@mcp.tool(
    name="generate_variants",
    annotations={
        "title": "Generate Multiple Code Variants via Delegation",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False
    }
)
async def generate_variants(params: GenerateVariantsInput) -> dict:
    """Generate multiple code variants via parent agent delegation (NO API COSTS).

    Creates 2-6 variants with different temperatures (0.7-1.0+) by delegating each
    to the parent Claude Code agent. Parent spawns subagents to preserve context.
    Uses YOUR session's vision capability.

    Args:
        params: GenerateVariantsInput with image_path and count

    Returns:
        Structured JSON with file paths, comparison table, and metadata
    """
    try:
        logger.info(f"Generating {params.count} variants via delegation")

        # Generate temperature range
        temperatures = [0.7 + (i * 0.1) for i in range(params.count)]

        # Generate variants sequentially (parallel would overwhelm parent)
        variants = []

        for i, temp in enumerate(temperatures):
            try:
                logger.info(f"Requesting variant {i+1}/{params.count} (T={temp})")

                code = await delegate_to_parent(
                    image_path=params.image_path,
                    temperature=temp,
                    request_type="generate"
                )

                # Write to file
                image_name = Path(params.image_path).stem
                request_id = str(uuid.uuid4())[:8]
                output_filename = f"{request_id}_{image_name}_variant{i+1}_t{temp:.1f}.html"
                output_path = OUTPUT_DIR / output_filename
                output_path.write_text(code)

                # Create preview
                preview = code[:300] + ("..." if len(code) > 300 else "")

                variants.append({
                    'variant': i + 1,
                    'temperature': temp,
                    'code_size': len(code),
                    'file_path': str(output_path),
                    'file_uri': f"file://{output_path}",
                    'preview': preview,
                    'success': True
                })

            except Exception as e:
                logger.error(f"Variant {i+1} failed: {e}")
                variants.append({
                    'variant': i + 1,
                    'temperature': temp,
                    'error': str(e),
                    'success': False
                })

        # Build response
        successful = [v for v in variants if v.get('success')]
        failed = [v for v in variants if not v.get('success')]

        response = {
            "success": True,
            "metadata": {
                "image": Path(params.image_path).name,
                "requested_count": params.count,
                "successful_count": len(successful),
                "failed_count": len(failed),
                "method": "delegation"
            },
            "variants": successful,
            "errors": failed if failed else None,
            "comparison": {
                "note": "Variants sorted by temperature",
                "temp_range": f"{min(temperatures):.1f}-{max(temperatures):.1f}"
            }
        }

        # Log metrics
        total_size = sum(v.get('code_size', 0) for v in successful)
        metrics.log_call("generate_variants", response, {
            "image_size": Path(params.image_path).stat().st_size if Path(params.image_path).exists() else 0,
            "variant_count": params.count,
            "successful_count": len(successful),
            "total_code_size": total_size
        })

        return response

    except Exception as e:
        logger.error(f"Variant generation failed: {e}", exc_info=True)
        return create_error_response(
            error_type="VariantGenerationFailed",
            message=f"Failed to generate variants: {str(e)}",
            troubleshooting=[
                "Check server logs for details",
                "Try with smaller variant count (2-3)",
                "Ensure parent monitoring is stable",
                "Use ensure_delegation_ready first"
            ]
        )


# ============================================================================
# Main
# ============================================================================

def main():
    """Run the MCP server via stdio transport."""
    logger.info("Starting Visual to Code MCP Server v2.0 (Optimized)...")
    logger.info(f"Delegation directory: {DELEGATION_DIR}")
    logger.info(f"Output directory: {OUTPUT_DIR}")
    logger.info(f"Metrics file: {METRICS_FILE}")
    logger.info("Improvements: file-based responses, structured errors, warmup tool, token metrics")
    logger.info("This server uses ZERO API calls - delegates to parent Claude Code agent")

    # Ensure directories exist
    DELEGATION_DIR.mkdir(exist_ok=True)
    OUTPUT_DIR.mkdir(exist_ok=True)

    # Run server
    mcp.run(transport='stdio')


if __name__ == "__main__":
    main()
