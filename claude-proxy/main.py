"""
Claude Code Proxy Backend

Routes screenshot-to-code API calls through Claude Code CLI
to use subscription billing instead of raw API credits.
"""

import asyncio
import base64
import io
import json
import math
import mimetypes
import os
import tempfile
from typing import Literal

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image
from moviepy import VideoFileClip

from session_manager import (
    generate_session_id,
    get_or_create_session,
    is_session_active,
    mark_session_active,
)

# Video processing settings
TARGET_NUM_FRAMES = 16  # Extract up to 16 frames from video
GRID_COLS = 4  # 4 columns in the frame grid
FRAME_WIDTH = 480  # Width of each frame in the grid (larger = better quality)


def extract_video_frames(video_data_url: str) -> list[Image.Image]:
    """Extract frames from a base64-encoded video."""
    # Decode the base64 URL to get the video bytes
    video_encoded_data = video_data_url.split(",")[1]
    video_bytes = base64.b64decode(video_encoded_data)

    mime_type = video_data_url.split(";")[0].split(":")[1]
    suffix = mimetypes.guess_extension(mime_type)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as temp_video_file:
        temp_video_file.write(video_bytes)
        temp_video_file.flush()

        clip = VideoFileClip(temp_video_file.name)
        images: list[Image.Image] = []
        # moviepy 2.x uses n_frames on clip, not reader.nframes
        total_frames = clip.n_frames if clip.n_frames else int(clip.duration * clip.fps)

        # Calculate frame skip interval
        frame_skip = max(1, math.ceil(total_frames / TARGET_NUM_FRAMES))

        for i, frame in enumerate(clip.iter_frames()):
            if i % frame_skip == 0:
                frame_image = Image.fromarray(frame)
                images.append(frame_image)
                if len(images) >= TARGET_NUM_FRAMES:
                    break

        clip.close()
        return images


def create_frame_grid(frames: list[Image.Image]) -> Image.Image:
    """Create a grid/mosaic image from video frames."""
    if not frames:
        raise ValueError("No frames to create grid from")

    # Resize frames to consistent width while maintaining aspect ratio
    resized_frames = []
    for frame in frames:
        aspect_ratio = frame.height / frame.width
        new_height = int(FRAME_WIDTH * aspect_ratio)
        resized = frame.resize((FRAME_WIDTH, new_height), Image.Resampling.LANCZOS)
        resized_frames.append(resized)

    # Calculate grid dimensions
    num_frames = len(resized_frames)
    num_cols = min(GRID_COLS, num_frames)
    num_rows = math.ceil(num_frames / num_cols)

    # Get max frame height for consistent row heights
    max_height = max(f.height for f in resized_frames)

    # Create the grid image
    grid_width = num_cols * FRAME_WIDTH
    grid_height = num_rows * max_height
    grid_image = Image.new("RGB", (grid_width, grid_height), color=(30, 30, 30))

    # Paste frames into grid
    for idx, frame in enumerate(resized_frames):
        row = idx // num_cols
        col = idx % num_cols
        x = col * FRAME_WIDTH
        y = row * max_height
        # Center frame vertically in its cell
        y_offset = (max_height - frame.height) // 2
        grid_image.paste(frame, (x, y + y_offset))

    return grid_image


def process_video_to_image(video_data_url: str) -> str:
    """Process video into a grid image and save to temp file."""
    print("Extracting frames from video...", flush=True)
    frames = extract_video_frames(video_data_url)
    print(f"Extracted {len(frames)} frames", flush=True)

    print("Creating frame grid...", flush=True)
    grid_image = create_frame_grid(frames)

    # Save grid to temp file
    fd, path = tempfile.mkstemp(suffix=".jpg")
    with os.fdopen(fd, "wb") as f:
        grid_image.save(f, format="JPEG", quality=90)

    print(f"Saved frame grid to: {path}")
    return path


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import and include app proxy router
from app_proxy import router as app_proxy_router, set_target_url
app.include_router(app_proxy_router)


# Pydantic models for API
class AppProxyConfig(BaseModel):
    target_url: str


@app.post("/config/app-proxy")
async def configure_app_proxy(config: AppProxyConfig):
    """Configure the target URL for the app proxy."""
    set_target_url(config.target_url)
    return {"status": "ok", "target_url": config.target_url}


@app.get("/config/app-proxy")
async def get_app_proxy_config():
    """Get the current app proxy configuration."""
    from app_proxy import TARGET_APP_URL
    return {"target_url": TARGET_APP_URL}


# Static file routes for testing
@app.get("/test-harness.html")
async def serve_test_harness():
    """Serve the test harness HTML file."""
    return FileResponse("test-harness.html", media_type="text/html")


# Mount test-app as static files
app.mount("/test-app", StaticFiles(directory="test-app", html=True), name="test-app")


# System prompts from screenshot-to-code
SYSTEM_PROMPTS = {
    "html_tailwind": """You are an expert Tailwind developer
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
Do not include markdown "```" or "```html" at the start or end.""",

    "html_css": """You are an expert CSS developer
You take screenshots of a reference web page from the user, and then build single page apps
using CSS, HTML and JS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "react_tailwind": """You are an expert React/Tailwind developer
You take screenshots of a reference web page from the user, and then build single page apps
using React and Tailwind CSS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use these script to include React so that it can run on a standalone page:
    <script src="https://cdn.jsdelivr.net/npm/react@18.0.0/umd/react.development.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/react-dom@18.0.0/umd/react-dom.development.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.js"></script>
- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "bootstrap": """You are an expert Bootstrap developer
You take screenshots of a reference web page from the user, and then build single page apps
using Bootstrap, HTML and JS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use this script to include Bootstrap: <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-T3c6CoIi6uLrA9TneNEoa7RxnatzjcDSCmG1MXxSR1GAsXEV/Dwwykc2MPK8M2HN" crossorigin="anonymous">
- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "vue_tailwind": """You are an expert Vue/Tailwind developer
You take screenshots of a reference web page from the user, and then build single page apps
using Vue and Tailwind CSS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use these script to include Vue so that it can run on a standalone page:
  <script src="https://registry.npmmirror.com/vue/3.3.11/files/dist/vue.global.js"></script>
- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- You can use Google Fonts
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "ionic_tailwind": """You are an expert Ionic/Tailwind developer
You take screenshots of a reference web page from the user, and then build single page apps
using Ionic and Tailwind CSS.

- Make sure the app looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.

In terms of libraries,

- Use these script to include Ionic so that it can run on a standalone page:
    <script type="module" src="https://cdn.jsdelivr.net/npm/@ionic/core/dist/ionic/ionic.esm.js"></script>
    <script nomodule src="https://cdn.jsdelivr.net/npm/@ionic/core/dist/ionic/ionic.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@ionic/core/css/ionic.bundle.css" />
- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- You can use Google Fonts

Return only the full code in <html></html> tags.
Do not include markdown "```" or "```html" at the start or end.""",

    "svg": """You are an expert at building SVGs.
You take screenshots of a reference web page from the user, and then build a SVG that looks exactly like the screenshot.

- Make sure the SVG looks exactly like the screenshot.
- Pay close attention to background color, text color, font size, font family,
padding, margin, border, etc. Match the colors and sizes exactly.
- Use the exact text from the screenshot.
- Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
- Repeat elements as needed to match the screenshot. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
- For images, use placeholder images from https://placehold.co and include a detailed description of the image in the alt text so that an image generation AI can generate the image later.
- You can use Google Fonts

Return only the full code in <svg></svg> tags.
Do not include markdown "```" or "```svg" at the start or end.""",
}

USER_PROMPT = "Generate code for a web page that looks exactly like this."
SVG_USER_PROMPT = "Generate code for a SVG that looks exactly like this."


def extract_html_content(code: str) -> str:
    """Extract HTML content, removing markdown fences if present."""
    code = code.strip()
    if code.startswith("```"):
        lines = code.split("\n")
        lines = lines[1:]  # Remove first line
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        code = "\n".join(lines)
    return code.strip()


def save_base64_image(data_url: str) -> str:
    """Save base64 data URL to temp file, return path."""
    # Parse data URL: data:image/png;base64,<data>
    if data_url.startswith("data:"):
        header, data = data_url.split(",", 1)
        # Extract mime type
        mime = header.split(":")[1].split(";")[0]
        ext = mime.split("/")[1]
        if ext == "jpeg":
            ext = "jpg"
    else:
        # Assume raw base64 PNG
        data = data_url
        ext = "png"

    # Decode and save
    image_data = base64.b64decode(data)
    fd, path = tempfile.mkstemp(suffix=f".{ext}")
    with os.fdopen(fd, "wb") as f:
        f.write(image_data)
    return path


async def generate_with_claude_cli(
    image_path: str | None,
    system_prompt: str,
    user_prompt: str,
    session_id: str | None = None,
    project_path: str | None = None,
) -> tuple[str, str]:
    """
    Call Claude CLI to generate code from image.
    Returns (result, session_id).
    """
    if image_path:
        prompt = f"Read the image at {image_path} and {user_prompt}"
    else:
        prompt = user_prompt

    cmd = [
        "claude",
        "-p", prompt,
        "--system-prompt", system_prompt,
        "--dangerously-skip-permissions",
        "--tools", "Read",
        "--output-format", "json",
    ]

    # Handle session persistence
    if session_id:
        if is_session_active(session_id):
            cmd.extend(["--resume", session_id])
        else:
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path or "")
    else:
        # Generate new session if project_path provided
        if project_path:
            session_id = generate_session_id(project_path)
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path if project_path else None,
    )

    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        error_msg = stderr.decode() if stderr else "Unknown error"
        raise Exception(f"Claude CLI error: {error_msg}")

    # Parse JSON response
    result = json.loads(stdout.decode())
    return result.get("result", ""), session_id or ""


async def generate_update_with_claude_cli(
    system_prompt: str,
    current_code: str,
    update_instruction: str,
    session_id: str | None = None,
    project_path: str | None = None,
) -> tuple[str, str]:
    """
    Call Claude CLI to update existing code based on instruction.
    Returns (result, session_id).
    """
    prompt = f"""Here is the current HTML code:

```html
{current_code}
```

User request: {update_instruction}

Update the code according to the user's request. Return ONLY the complete updated HTML code, nothing else. Do not include markdown fences. Start with <!DOCTYPE html> or <html> and end with </html>."""

    cmd = [
        "claude",
        "-p", prompt,
        "--system-prompt", system_prompt,
        "--dangerously-skip-permissions",
        "--output-format", "json",
    ]

    # Handle session persistence
    if session_id:
        if is_session_active(session_id):
            cmd.extend(["--resume", session_id])
        else:
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path or "")
    else:
        if project_path:
            session_id = generate_session_id(project_path)
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path if project_path else None,
    )

    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        error_msg = stderr.decode() if stderr else "Unknown error"
        raise Exception(f"Claude CLI error: {error_msg}")

    # Parse JSON response
    result = json.loads(stdout.decode())
    return result.get("result", ""), session_id or ""


@app.get("/")
async def root():
    return {
        "status": "ok",
        "message": "Claude Code Proxy - Routes screenshot-to-code through subscription billing",
    }


@app.websocket("/generate-code")
async def generate_code(websocket: WebSocket):
    """WebSocket endpoint compatible with screenshot-to-code frontend."""
    await websocket.accept()
    print("Incoming websocket connection...", flush=True)

    try:
        # Receive parameters from frontend
        print("Waiting for params...", flush=True)
        params = await websocket.receive_json()
        print(f"Received params: keys={list(params.keys())}", flush=True)

        # Extract key parameters
        stack = params.get("generatedCodeConfig", "html_tailwind")
        input_mode = params.get("inputMode", "image")
        generation_type = params.get("generationType", "create")
        history = params.get("history", [])

        # Session parameters (new)
        session_id = params.get("session_id")
        project_path = params.get("project_path")

        print(f"Stack: {stack}, InputMode: {input_mode}, GenerationType: {generation_type}", flush=True)
        print(f"Session: {session_id}, Project: {project_path}", flush=True)

        # Map stack names to our keys
        stack_map = {
            "html_tailwind": "html_tailwind",
            "html_css": "html_css",
            "react_tailwind": "react_tailwind",
            "bootstrap": "bootstrap",
            "vue_tailwind": "vue_tailwind",
            "ionic_tailwind": "ionic_tailwind",
            "svg": "svg",
        }
        stack_key = stack_map.get(stack, "html_tailwind")
        system_prompt = SYSTEM_PROMPTS.get(stack_key, SYSTEM_PROMPTS["html_tailwind"])
        user_prompt = SVG_USER_PROMPT if stack == "svg" else USER_PROMPT

        # Tell frontend we're using 1 variant (Claude CLI mode)
        await websocket.send_json({"type": "variantCount", "value": "1", "variantIndex": 0})

        # Handle UPDATE requests (Select and update feature)
        if generation_type == "update" and history:
            print(f"Processing UPDATE request with {len(history)} history items", flush=True)
            await websocket.send_json({"type": "status", "value": "Updating code via Claude Code...", "variantIndex": 0})

            # History format:
            # - Even indices (0, 2, 4...): assistant messages (generated code)
            # - Odd indices (1, 3, 5...): user messages (update instructions)
            # The last item is the user's update instruction

            # Get the most recent code (second to last item, which is assistant's code)
            if len(history) >= 2:
                current_code = history[-2].get("text", "")
            else:
                # Fallback: shouldn't happen but handle gracefully
                current_code = history[0].get("text", "") if history else ""

            # Get the update instruction (last item)
            update_instruction = history[-1].get("text", "")

            print(f"Current code length: {len(current_code)}", flush=True)
            print(f"Update instruction: {update_instruction[:200]}...", flush=True)

            try:
                # Generate updated code via Claude CLI
                result, returned_session_id = await generate_update_with_claude_cli(
                    system_prompt=system_prompt,
                    current_code=current_code,
                    update_instruction=update_instruction,
                    session_id=session_id,
                    project_path=project_path,
                )

                # Extract and clean HTML
                html_code = extract_html_content(result)

                # Send result back to frontend
                await websocket.send_json({"type": "setCode", "value": html_code, "variantIndex": 0})
                await websocket.send_json({
                    "type": "variantComplete",
                    "value": "Update complete",
                    "variantIndex": 0,
                    "session_id": returned_session_id,
                })

            except Exception as e:
                print(f"Update error: {e}", flush=True)
                raise

        # Handle CREATE requests (initial generation)
        else:
            # Extract image/video from prompt
            prompt_data = params.get("prompt", {})
            images = prompt_data.get("images", [])

            if not images:
                await websocket.send_json({"type": "error", "value": "No image provided"})
                await websocket.close()
                return

            data_url = images[0]

            # Handle video vs image input
            if input_mode == "video":
                await websocket.send_json({"type": "status", "value": "Extracting video frames...", "variantIndex": 0})
                image_path = process_video_to_image(data_url)
                # Update user prompt for video context - BE VERY STRICT about output format
                user_prompt = """These are frames extracted from a video recording of a web page. Generate HTML/Tailwind code that recreates the UI shown.

CRITICAL: Return ONLY the HTML code. Do NOT include any explanation, description, or commentary. Do NOT describe what you see. Start directly with <!DOCTYPE html> or <html> and end with </html>. Nothing else."""
                await websocket.send_json({"type": "status", "value": "Generating code via Claude Code...", "variantIndex": 0})
            else:
                await websocket.send_json({"type": "status", "value": "Generating code via Claude Code...", "variantIndex": 0})
                # Save image to temp file
                image_path = save_base64_image(data_url)

            print(f"Saved {'video frames' if input_mode == 'video' else 'image'} to: {image_path}", flush=True)

            try:
                # Generate code via Claude CLI
                result, returned_session_id = await generate_with_claude_cli(
                    image_path=image_path,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    session_id=session_id,
                    project_path=project_path,
                )

                # Extract and clean HTML
                html_code = extract_html_content(result)

                # Send result back to frontend
                await websocket.send_json({"type": "setCode", "value": html_code, "variantIndex": 0})
                await websocket.send_json({
                    "type": "variantComplete",
                    "value": "Generation complete",
                    "variantIndex": 0,
                    "session_id": returned_session_id,
                })

            finally:
                # Cleanup temp file
                if os.path.exists(image_path):
                    os.unlink(image_path)

    except Exception as e:
        import traceback
        print(f"Error: {e}", flush=True)
        traceback.print_exc()
        try:
            await websocket.send_json({"type": "error", "value": str(e)})
        except Exception:
            pass

    finally:
        print("Closing websocket connection", flush=True)
        try:
            await websocket.close()
        except Exception:
            pass


async def edit_element_with_claude_cli(
    element_html: str,
    instruction: str,
    project_path: str,
    element_xpath: str | None = None,
    element_classes: list[str] | None = None,
    session_id: str | None = None,
) -> tuple[str, str]:
    """
    Call Claude CLI to edit an element in a real project.
    Returns (result, session_id).
    """
    # Build context about the element
    element_context = f"Element HTML:\n```html\n{element_html}\n```"
    if element_xpath:
        element_context += f"\n\nXPath: {element_xpath}"
    if element_classes:
        element_context += f"\n\nCSS Classes: {', '.join(element_classes)}"

    prompt = f"""The user is pointing at this element in their running web app:

{element_context}

Their request: {instruction}

Find the source file that renders this element and make the requested change.
Use Glob and Grep to search the codebase, Read to examine files, and Edit to make changes.
After making changes, briefly confirm what you changed."""

    system_prompt = """You are a code editor assistant. The user has selected an element in their running web application and wants you to modify it.

Your task:
1. Find the source file that contains or renders this element
2. Make the requested modification
3. Confirm what you changed

Tips for finding the element:
- Search for unique text content, class names, or IDs
- Look in common locations: src/, components/, pages/, app/
- The element might be in a React component, Vue component, or plain HTML file

Be precise and minimal - only change what's necessary."""

    cmd = [
        "claude",
        "-p", prompt,
        "--system-prompt", system_prompt,
        "--dangerously-skip-permissions",
        "--output-format", "json",
    ]

    # Handle session persistence
    if session_id:
        if is_session_active(session_id):
            cmd.extend(["--resume", session_id])
        else:
            cmd.extend(["--session-id", session_id])
            mark_session_active(session_id, project_path)
    else:
        # Generate new session from project path
        session_id = generate_session_id(project_path)
        cmd.extend(["--session-id", session_id])
        mark_session_active(session_id, project_path)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=project_path,
    )

    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        error_msg = stderr.decode() if stderr else "Unknown error"
        raise Exception(f"Claude CLI error: {error_msg}")

    # Parse JSON response
    result = json.loads(stdout.decode())
    return result.get("result", ""), session_id or ""


@app.websocket("/edit-element")
async def edit_element(websocket: WebSocket):
    """WebSocket endpoint for element-based editing with Claude."""
    await websocket.accept()
    print("[edit-element] Connection opened", flush=True)

    try:
        # Receive edit request
        data = await websocket.receive_json()
        print(f"[edit-element] Received request: {list(data.keys())}", flush=True)

        element = data.get("element", {})
        instruction = data.get("instruction", "")
        project_path = data.get("projectPath", "")
        session_id = data.get("session_id")

        print(f"[edit-element] Session: {session_id}, Project: {project_path}", flush=True)

        # Validate required fields
        if not element.get("outerHTML"):
            await websocket.send_json({
                "type": "error",
                "message": "No element HTML provided"
            })
            return

        if not instruction:
            await websocket.send_json({
                "type": "error",
                "message": "No instruction provided"
            })
            return

        if not project_path:
            await websocket.send_json({
                "type": "error",
                "message": "No project path provided"
            })
            return

        # Verify project path exists
        if not os.path.isdir(project_path):
            await websocket.send_json({
                "type": "error",
                "message": f"Project path does not exist: {project_path}"
            })
            return

        # Send status update
        await websocket.send_json({
            "type": "status",
            "message": "Finding and editing element..."
        })

        # Call Claude to edit the element
        try:
            result, returned_session_id = await edit_element_with_claude_cli(
                element_html=element.get("outerHTML", ""),
                instruction=instruction,
                project_path=project_path,
                element_xpath=element.get("xpath"),
                element_classes=element.get("classList", []),
                session_id=session_id,
            )

            await websocket.send_json({
                "type": "result",
                "message": result,
                "session_id": returned_session_id,
            })

        except Exception as e:
            print(f"[edit-element] Claude error: {e}", flush=True)
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })

    except Exception as e:
        import traceback
        print(f"[edit-element] Error: {e}", flush=True)
        traceback.print_exc()
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except Exception:
            pass

    finally:
        print("[edit-element] Connection closing", flush=True)
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/chat")
async def unified_chat(websocket: WebSocket):
    """
    Unified chat WebSocket endpoint for all modes.
    Provides streaming responses with session persistence.
    """
    await websocket.accept()
    print("[ws/chat] Connection opened", flush=True)

    try:
        while True:
            # Receive chat message
            data = await websocket.receive_json()
            print(f"[ws/chat] Received: {list(data.keys())}", flush=True)

            message = data.get("message", "")
            context = data.get("context", "")
            session_id = data.get("session_id")
            project_path = data.get("project_path", "")

            if not message:
                await websocket.send_json({
                    "type": "error",
                    "message": "No message provided"
                })
                continue

            # Build prompt with context if provided
            if context:
                prompt = f"Context:\n{context}\n\nRequest: {message}"
            else:
                prompt = message

            # Build command
            cmd = [
                "claude",
                "-p", prompt,
                "--dangerously-skip-permissions",
                "--output-format", "stream-json",
            ]

            # Handle session persistence
            if session_id:
                if is_session_active(session_id):
                    cmd.extend(["--resume", session_id])
                else:
                    cmd.extend(["--session-id", session_id])
                    mark_session_active(session_id, project_path)
            elif project_path:
                session_id = generate_session_id(project_path)
                cmd.extend(["--session-id", session_id])
                mark_session_active(session_id, project_path)

            print(f"[ws/chat] Session: {session_id}", flush=True)

            # Send session info
            await websocket.send_json({
                "type": "session",
                "session_id": session_id or "",
            })

            # Start streaming process
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=project_path if project_path else None,
            )

            # Stream output line by line
            try:
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        break

                    line_str = line.decode().strip()
                    if not line_str:
                        continue

                    try:
                        event = json.loads(line_str)
                        event_type = event.get("type", "")

                        if event_type == "assistant":
                            # Text content from Claude
                            content = event.get("message", {}).get("content", [])
                            for block in content:
                                if block.get("type") == "text":
                                    await websocket.send_json({
                                        "type": "text",
                                        "content": block.get("text", ""),
                                    })

                        elif event_type == "tool_use":
                            # Tool being used
                            await websocket.send_json({
                                "type": "tool_use",
                                "tool": event.get("tool", ""),
                                "input": event.get("input", {}),
                            })

                        elif event_type == "tool_result":
                            # Tool result
                            await websocket.send_json({
                                "type": "tool_result",
                                "result": event.get("result", ""),
                            })

                        elif event_type == "result":
                            # Final result
                            await websocket.send_json({
                                "type": "complete",
                                "content": event.get("result", ""),
                                "session_id": session_id or "",
                            })

                    except json.JSONDecodeError:
                        # Non-JSON output, send as raw text
                        await websocket.send_json({
                            "type": "raw",
                            "content": line_str,
                        })

                # Wait for process to complete
                await proc.wait()

                if proc.returncode != 0:
                    stderr = await proc.stderr.read()
                    error_msg = stderr.decode() if stderr else "Unknown error"
                    await websocket.send_json({
                        "type": "error",
                        "message": error_msg,
                    })

            except Exception as e:
                proc.kill()
                await websocket.send_json({
                    "type": "error",
                    "message": str(e),
                })

    except Exception as e:
        import traceback
        print(f"[ws/chat] Error: {e}", flush=True)
        traceback.print_exc()
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except Exception:
            pass

    finally:
        print("[ws/chat] Connection closing", flush=True)
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7001)
