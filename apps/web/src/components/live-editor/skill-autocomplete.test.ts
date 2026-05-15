import { describe, expect, it } from "vitest";

import type { RegisteredSkill } from "@/store/session-store";

import {
  applySkillAutocomplete,
  findSkillAutocompleteMatch,
  getSkillAutocompleteSuggestions,
} from "./skill-autocomplete";

const skills: RegisteredSkill[] = [
  {
    name: "frontend-design",
    description: "Improve spacing and visual polish.",
    sourcePaths: ["/tmp/resources/frontend-design"],
    installPaths: ["/home/user/.codex/skills/frontend-design"],
    installedTargets: ["codex"],
    installedInPixelForge: false,
  },
  {
    name: "using-pixel-forge",
    description: "Pixel Forge workflow help.",
    sourcePaths: ["/tmp/resources/using-pixel-forge"],
    installPaths: ["/home/user/.pixel-forge/skills/installed/using-pixel-forge"],
    installedTargets: ["pixel-forge"],
    installedInPixelForge: true,
  },
  {
    name: "frontend-aesthetics",
    description: "Frontend visual design critique.",
    sourcePaths: ["/tmp/resources/frontend-aesthetics"],
    installPaths: [],
    installedTargets: [],
    installedInPixelForge: false,
  },
];

describe("skill autocomplete", () => {
  it("finds a slash-skill token at the caret", () => {
    expect(
      findSkillAutocompleteMatch("Please use /front", "Please use /front".length)
    ).toEqual({
      start: 11,
      end: 17,
      query: "front",
    });
  });

  it("ignores filesystem-like slash paths", () => {
    expect(
      findSkillAutocompleteMatch("Read /tmp/workspace first", 10)
    ).toBeNull();
  });

  it("only suggests skills installed for the preferred target", () => {
    const suggestions = getSkillAutocompleteSuggestions(skills, "front", "codex");
    expect(suggestions.map((skill) => skill.name)).toEqual([
      "frontend-design",
    ]);
  });

  it("replaces the active token with a completed skill command", () => {
    const match = findSkillAutocompleteMatch("Please use /front", "Please use /front".length);
    expect(match).not.toBeNull();
    expect(applySkillAutocomplete("Please use /front", match!, "frontend-design")).toEqual({
      value: "Please use /frontend-design ",
      caret: "Please use /frontend-design ".length,
    });
  });
});
