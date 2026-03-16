#!/usr/bin/env python3
"""
Programmatic testing of Pixel Forge screenshot mode with multiple models
"""
import asyncio
import base64
import json
import time
from pathlib import Path
import httpx

BACKEND_URL = "http://localhost:7001"
REPO_ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = REPO_ROOT / "results" / "phase1"

# Test configurations - Only Sonnet 4.5
TESTS = [
    {
        "name": "test-2-sonnet-4.5",
        "image": str(REPO_ROOT / "examples" / "test-2-invoice-card.png"),
        "model": "claude-sonnet-4-5-20250929",
        "output": RESULTS_DIR / "sonnet-4.5" / "test-2-output.tsx",
        "description": "Simple Invoice Card with Claude Sonnet 4.5"
    },
    {
        "name": "test-3-sonnet-4.5",
        "image": str(REPO_ROOT / "examples" / "test-3-styled-invoice-card.png"),
        "model": "claude-sonnet-4-5-20250929",
        "output": RESULTS_DIR / "sonnet-4.5" / "test-3-output.tsx",
        "description": "Styled Matrix Card with Claude Sonnet 4.5"
    }
]

async def generate_code(image_path: str, model: str, test_name: str) -> dict:
    """Call the Pixel Forge backend API to generate code."""
    print(f"\n{'='*80}")
    print(f"Running: {test_name}")
    print(f"Image: {Path(image_path).name}")
    print(f"Model: {model}")
    print(f"{'='*80}")

    # Read and encode image
    with open(image_path, "rb") as f:
        image_data = base64.b64encode(f.read()).decode()

    # Prepare request payload
    payload = {
        "image": image_data,
        "generationType": "create",
        "model": model,
        "codeGenerationParams": {
            "stack": "react_tailwind"
        }
    }

    start_time = time.time()

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            print(f"Sending request to {BACKEND_URL}/generate-code...")
            response = await client.post(
                f"{BACKEND_URL}/generate-code",
                json=payload
            )
            response.raise_for_status()

            duration = time.time() - start_time
            result = response.json()

            print(f"✅ Generation completed in {duration:.2f} seconds")

            return {
                "success": True,
                "code": result.get("code", ""),
                "duration": duration,
                "model": model,
                "error": None
            }

    except Exception as e:
        duration = time.time() - start_time
        print(f"❌ Generation failed after {duration:.2f} seconds")
        print(f"Error: {str(e)}")

        return {
            "success": False,
            "code": None,
            "duration": duration,
            "model": model,
            "error": str(e)
        }

async def run_all_tests():
    """Run all test combinations"""
    results = []

    print(f"\n{'#'*80}")
    print(f"# Pixel Forge Automated Testing")
    print(f"# Testing 2 images with Claude Sonnet 4.5")
    print(f"{'#'*80}")

    for test_config in TESTS:
        print(f"\n{'='*80}")
        print(f"Test {len(results) + 1}/2: {test_config['description']}")
        print(f"{'='*80}")

        result = await generate_code(
            test_config["image"],
            test_config["model"],
            test_config["name"]
        )

        # Save generated code
        if result["success"] and result["code"]:
            output_path = test_config["output"]
            output_path.parent.mkdir(parents=True, exist_ok=True)

            with open(output_path, "w") as f:
                f.write(result["code"])

            print(f"✅ Code saved to: {output_path}")
            print(f"   Code length: {len(result['code'])} characters")

        results.append({
            "test": test_config["name"],
            "description": test_config["description"],
            "model": test_config["model"],
            "image": Path(test_config["image"]).name,
            "output": str(test_config["output"]),
            "success": result["success"],
            "duration": result["duration"],
            "code_length": len(result["code"]) if result["code"] else 0,
            "error": result["error"]
        })

        # Wait between tests to avoid rate limiting
        if len(results) < len(TESTS):
            print("\nWaiting 5 seconds before next test...")
            await asyncio.sleep(5)

    # Save results summary
    summary_path = RESULTS_DIR / "test-summary.json"
    with open(summary_path, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\n{'#'*80}")
    print(f"# All tests completed!")
    print(f"# Summary saved to: {summary_path}")
    print(f"{'#'*80}\n")

    # Print summary
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)

    for r in results:
        status = "✅" if r["success"] else "❌"
        print(f"\n{status} {r['description']}")
        print(f"   Model: {r['model']}")
        print(f"   Duration: {r['duration']:.2f}s")
        print(f"   Code length: {r['code_length']} chars")
        if r["error"]:
            print(f"   Error: {r['error']}")

    print("\n" + "="*80)

if __name__ == "__main__":
    asyncio.run(run_all_tests())
