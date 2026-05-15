import type { RegisteredSkill } from "@/store/session-store";

export interface SkillAutocompleteMatch {
  start: number;
  end: number;
  query: string;
}

export interface AppliedSkillAutocomplete {
  value: string;
  caret: number;
}

const SKILL_TOKEN_RE = /^\/[A-Za-z0-9-]*$/;

function skillRank(
  skill: RegisteredSkill,
  query: string,
  preferredTarget: string | null | undefined
): [number, number, number, string] {
  const normalizedQuery = query.trim().toLowerCase();
  const name = skill.name.toLowerCase();
  const description = (skill.description || "").toLowerCase();
  const preferredInstalled =
    preferredTarget && skill.installedTargets.includes(preferredTarget) ? 0 : 1;
  const installedAnywhere = skill.installPaths.length > 0 ? 0 : 1;

  let queryRank = 0;
  if (normalizedQuery) {
    if (name.startsWith(normalizedQuery)) {
      queryRank = 0;
    } else if (name.includes(normalizedQuery)) {
      queryRank = 1;
    } else if (description.includes(normalizedQuery)) {
      queryRank = 2;
    } else {
      queryRank = 3;
    }
  }

  return [preferredInstalled, installedAnywhere, queryRank, skill.name];
}

export function findSkillAutocompleteMatch(
  input: string,
  caretIndex: number
): SkillAutocompleteMatch | null {
  const clampedCaret = Math.max(0, Math.min(caretIndex, input.length));
  let start = clampedCaret;
  while (start > 0 && !/\s/.test(input[start - 1] || "")) {
    start -= 1;
  }

  let end = clampedCaret;
  while (end < input.length && !/\s/.test(input[end] || "")) {
    end += 1;
  }

  const token = input.slice(start, end);
  if (!SKILL_TOKEN_RE.test(token)) {
    return null;
  }

  return {
    start,
    end,
    query: token.slice(1).toLowerCase(),
  };
}

export function getSkillAutocompleteSuggestions(
  skills: RegisteredSkill[],
  query: string,
  preferredTarget?: string | null
): RegisteredSkill[] {
  const normalizedQuery = query.trim().toLowerCase();

  return [...skills]
    .filter((skill) => {
      if (preferredTarget && !skill.installedTargets.includes(preferredTarget)) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      const name = skill.name.toLowerCase();
      const description = (skill.description || "").toLowerCase();
      return name.includes(normalizedQuery) || description.includes(normalizedQuery);
    })
    .sort((left, right) => {
      const leftRank = skillRank(left, normalizedQuery, preferredTarget);
      const rightRank = skillRank(right, normalizedQuery, preferredTarget);
      return (
        leftRank[0] - rightRank[0]
        || leftRank[1] - rightRank[1]
        || leftRank[2] - rightRank[2]
        || leftRank[3].localeCompare(rightRank[3])
      );
    });
}

export function applySkillAutocomplete(
  input: string,
  match: SkillAutocompleteMatch,
  skillName: string
): AppliedSkillAutocomplete {
  const before = input.slice(0, match.start);
  const after = input.slice(match.end);
  const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
  const replacement = `/${skillName}${needsTrailingSpace ? " " : ""}`;
  const value = `${before}${replacement}${after}`;
  return {
    value,
    caret: before.length + replacement.length,
  };
}
