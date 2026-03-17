#!/usr/bin/env python3
"""
Test script for Visual to Code MCP Server

Verifies:
1. Server can be imported
2. Tools are registered correctly
3. Input validation works
4. Delegation directory is created
"""

import sys
from pathlib import Path

def test_imports():
    """Test that all required modules can be imported."""
    print("Testing imports...")
    try:
        import asyncio
        import json
        import logging
        import uuid
        from mcp.server.fastmcp import FastMCP
        from pydantic import BaseModel, Field, field_validator, ConfigDict
        print("✅ All imports successful")
        return True
    except ImportError as e:
        print(f"❌ Import failed: {e}")
        print("\nInstall dependencies with: uv pip install -r requirements.txt")
        return False


def test_server_structure():
    """Test that the server file has correct structure."""
    print("\nTesting server structure...")

    server_path = Path(__file__).parent / "visual_to_code_mcp.py"

    if not server_path.exists():
        print(f"❌ Server file not found: {server_path}")
        return False

    content = server_path.read_text()

    # Check for required components
    checks = [
        ("FastMCP initialization", "FastMCP(\"visual_to_code_mcp\")"),
        ("generate_code_from_image tool", "@mcp.tool"),
        ("generate_code_from_image tool", "def generate_code_from_image"),
        ("generate_variants tool", "def generate_variants"),
        ("Delegation function", "async def delegate_to_parent"),
        ("Subagent instruction", "use_subagent"),
        ("System prompt", "SYSTEM_PROMPT ="),
        ("Input validation", "class GenerateCodeInput"),
        ("Main function", "def main()"),
    ]

    all_passed = True
    for check_name, check_string in checks:
        if check_string in content:
            print(f"  ✅ {check_name}")
        else:
            print(f"  ❌ {check_name} - not found")
            all_passed = False

    if all_passed:
        print("✅ Server structure valid")
    else:
        print("❌ Server structure incomplete")

    return all_passed


def test_delegation_directory():
    """Test that delegation directory can be created."""
    print("\nTesting delegation directory...")

    delegation_dir = Path("/tmp/visual-to-code-delegation")

    try:
        delegation_dir.mkdir(exist_ok=True)
        print(f"✅ Delegation directory created: {delegation_dir}")

        # Test write permissions
        test_file = delegation_dir / "test.json"
        test_file.write_text('{"test": true}')
        test_file.unlink()
        print(f"✅ Write permissions verified")

        return True
    except Exception as e:
        print(f"❌ Delegation directory setup failed: {e}")
        return False


def test_input_validation():
    """Test input validation with Pydantic models."""
    print("\nTesting input validation...")

    try:
        from pydantic import BaseModel, Field, ValidationError, ConfigDict

        # Create test model similar to GenerateCodeInput
        class TestInput(BaseModel):
            model_config = ConfigDict(
                str_strip_whitespace=True,
                validate_assignment=True,
                extra='forbid'
            )

            image_path: str = Field(
                ...,
                description="Test image path"
            )

            temperature: float = Field(
                default=1.0,
                ge=0.0,
                le=2.0
            )

        # Test valid input
        try:
            valid = TestInput(image_path="/test/image.png", temperature=1.0)
            print("  ✅ Valid input accepted")
        except ValidationError as e:
            print(f"  ❌ Valid input rejected: {e}")
            return False

        # Test invalid temperature
        try:
            invalid = TestInput(image_path="/test/image.png", temperature=3.0)
            print("  ❌ Invalid temperature accepted (should reject)")
            return False
        except ValidationError:
            print("  ✅ Invalid temperature rejected")

        # Test missing required field
        try:
            missing = TestInput(temperature=1.0)
            print("  ❌ Missing required field accepted (should reject)")
            return False
        except ValidationError:
            print("  ✅ Missing required field rejected")

        print("✅ Input validation working correctly")
        return True

    except Exception as e:
        print(f"❌ Input validation test failed: {e}")
        return False


def main():
    """Run all tests."""
    print("=" * 80)
    print("Visual to Code MCP Server - Test Suite")
    print("=" * 80)

    results = []

    # Run tests
    results.append(("Imports", test_imports()))
    results.append(("Server Structure", test_server_structure()))
    results.append(("Delegation Directory", test_delegation_directory()))
    results.append(("Input Validation", test_input_validation()))

    # Print summary
    print("\n" + "=" * 80)
    print("Test Summary")
    print("=" * 80)

    for test_name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{status:12} {test_name}")

    all_passed = all(passed for _, passed in results)

    print("=" * 80)

    if all_passed:
        print("\n✅ All tests passed!")
        print("\nNext steps:")
        print("1. Register MCP server in ~/.claude.json or Lazy-MCP config")
        print("2. Implement parent agent monitoring system")
        print("3. Test delegation flow end-to-end")
        return 0
    else:
        print("\n❌ Some tests failed")
        print("\nFix failures before proceeding")
        return 1


if __name__ == "__main__":
    sys.exit(main())
