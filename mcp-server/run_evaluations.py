#!/usr/bin/env python3
"""
Evaluation runner for Visual to Code MCP Server

Loads evaluations from evaluations.jsonl and provides assessment framework.
Actual testing requires deployed MCP server and parent monitoring system.
"""

import json
from pathlib import Path
from typing import Dict, List


def load_evaluations(eval_file: Path) -> List[Dict]:
    """Load evaluation cases from JSONL file."""
    evaluations = []

    with open(eval_file, 'r') as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue

            try:
                eval_case = json.loads(line)
                evaluations.append(eval_case)
            except json.JSONDecodeError as e:
                print(f"⚠️  Line {line_num}: Invalid JSON - {e}")

    return evaluations


def print_evaluation_summary(evaluations: List[Dict]):
    """Print summary of evaluation cases."""
    print("=" * 80)
    print("Visual to Code MCP Server - Evaluation Summary")
    print("=" * 80)
    print(f"\nTotal Evaluations: {len(evaluations)}")
    print("\nCategories:")

    categories = {
        "Basic functionality": 0,
        "Input validation": 0,
        "Error handling": 0,
        "Edge cases": 0,
        "Architecture": 0,
    }

    for eval_case in evaluations:
        prompt = eval_case.get("prompt", "")

        if "generate code from" in prompt.lower() or "convert" in prompt.lower():
            categories["Basic functionality"] += 1
        elif "invalid" in prompt.lower() or "nonexistent" in prompt.lower():
            categories["Input validation"] += 1
        elif "error" in prompt.lower() or "timeout" in prompt.lower():
            categories["Error handling"] += 1
        elif "variants" in prompt.lower() or "temperature" in prompt.lower():
            categories["Edge cases"] += 1
        elif "verify" in prompt.lower() or "check" in prompt.lower():
            categories["Architecture"] += 1

    for category, count in categories.items():
        if count > 0:
            print(f"  - {category}: {count}")

    print("\n" + "=" * 80)


def print_evaluation_details(evaluations: List[Dict]):
    """Print detailed evaluation cases."""
    print("\nEvaluation Cases:\n")

    for i, eval_case in enumerate(evaluations, 1):
        print(f"{i}. {eval_case['prompt']}")
        print(f"   Expected: {eval_case['expected_behavior']}")
        print(f"   Success Criteria ({len(eval_case['success_criteria'])}):")

        for criterion in eval_case['success_criteria']:
            print(f"     • {criterion}")

        print()


def print_testing_instructions():
    """Print instructions for running evaluations."""
    print("=" * 80)
    print("Testing Instructions")
    print("=" * 80)
    print("""
1. Deploy MCP Server
   - Install dependencies: uv pip install -r requirements.txt
   - Register in ~/.claude.json or Lazy-MCP config
   - Restart Claude Code

2. Implement Parent Monitoring System
   - Create monitoring script to watch /tmp/visual-to-code-delegation/
   - Spawn subagents when requests detected
   - Process images with vision capability
   - Write responses with generated code

3. Run Manual Tests
   - Start Claude Code with MCP server enabled
   - Execute prompts from evaluations
   - Verify success criteria for each case
   - Check delegation files created correctly

4. Automated Testing (Future)
   - Create mock parent agent for unit tests
   - Simulate delegation flow
   - Verify tool responses programmatically

5. Integration Testing
   - Test with real images from examples/
   - Verify 85-90% visual accuracy
   - Check generated code quality
   - Validate HTML/Tailwind output

Evaluation Metrics:
- ✅ All success criteria met
- ⚠️  Partial success (some criteria met)
- ❌ Failure (criteria not met)
""")
    print("=" * 80)


def main():
    """Main evaluation runner."""
    eval_file = Path(__file__).parent / "evaluations.jsonl"

    if not eval_file.exists():
        print(f"❌ Evaluation file not found: {eval_file}")
        return 1

    # Load evaluations
    evaluations = load_evaluations(eval_file)

    if not evaluations:
        print("❌ No evaluations loaded")
        return 1

    # Print summary
    print_evaluation_summary(evaluations)

    # Print details
    print_evaluation_details(evaluations)

    # Print instructions
    print_testing_instructions()

    print("\n✅ Loaded {} evaluation cases".format(len(evaluations)))
    print("\nNext steps:")
    print("1. Deploy MCP server (Phase 5)")
    print("2. Implement parent monitoring system")
    print("3. Run manual tests against deployed server")
    print("4. Document results\n")

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
