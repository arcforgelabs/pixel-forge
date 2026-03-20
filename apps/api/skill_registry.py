from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from runtime_config import skills_install_dir as runtime_skills_install_dir


FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n?", re.DOTALL)
FRONTMATTER_FIELD_RE = re.compile(r"(?m)^([A-Za-z0-9_-]+):\s*(.+?)\s*$")


@dataclass(slots=True)
class SkillRegistryLocation:
    id: str
    label: str
    path: str
    role: str
    target: str | None
    managed: bool


@dataclass(slots=True)
class RegisteredSkill:
    name: str
    description: str | None
    source_paths: list[str]
    install_paths: list[str]
    installed_targets: list[str]
    installed_in_pixel_forge: bool


@dataclass(slots=True)
class SkillRegistrySnapshot:
    source_roots: list[SkillRegistryLocation]
    install_destinations: list[SkillRegistryLocation]
    skills: list[RegisteredSkill]


def _default_source_roots() -> list[SkillRegistryLocation]:
    return [
        SkillRegistryLocation(
            id="resources-skills",
            label="Resources Skills",
            path=str(Path.home() / "repos" / "3-resources" / "SKILLS"),
            role="source",
            target="resources",
            managed=False,
        )
    ]


def _default_install_destinations() -> list[SkillRegistryLocation]:
    return [
        SkillRegistryLocation(
            id="pixel-forge-skills",
            label="Pixel Forge",
            path=str(runtime_skills_install_dir()),
            role="destination",
            target="pixel-forge",
            managed=True,
        ),
        SkillRegistryLocation(
            id="claude-skills",
            label="Claude Code",
            path=str(Path.home() / ".claude" / "skills"),
            role="destination",
            target="claude",
            managed=False,
        ),
        SkillRegistryLocation(
            id="codex-skills",
            label="Codex",
            path=str(Path.home() / ".codex" / "skills"),
            role="destination",
            target="codex",
            managed=False,
        ),
        SkillRegistryLocation(
            id="openclaw-skills",
            label="OpenClaw",
            path=str(Path.home() / ".openclaw" / "skills"),
            role="destination",
            target="openclaw",
            managed=False,
        ),
    ]


def load_skill_registry_snapshot() -> SkillRegistrySnapshot:
    source_roots = _default_source_roots()
    install_destinations = _default_install_destinations()

    skills_by_name: dict[str, RegisteredSkill] = {}

    for location in install_destinations:
        root = Path(location.path).expanduser()
        if not root.is_dir():
            continue

        for skill_file in root.rglob("SKILL.md"):
            metadata = _read_skill_metadata(skill_file)
            skill_name = metadata["name"]
            record = skills_by_name.get(skill_name)
            if record is None:
                record = RegisteredSkill(
                    name=skill_name,
                    description=metadata["description"],
                    source_paths=[],
                    install_paths=[],
                    installed_targets=[],
                    installed_in_pixel_forge=False,
                )
                skills_by_name[skill_name] = record
            elif not record.description and metadata["description"]:
                record.description = metadata["description"]

            skill_path = str(skill_file.parent)
            if skill_path not in record.install_paths:
                record.install_paths.append(skill_path)
            if location.target and location.target not in record.installed_targets:
                record.installed_targets.append(location.target)
            if location.target == "pixel-forge":
                record.installed_in_pixel_forge = True

    for location in source_roots:
        root = Path(location.path).expanduser()
        if not root.is_dir():
            continue

        for skill_file in root.rglob("SKILL.md"):
            metadata = _read_skill_metadata(skill_file)
            record = skills_by_name.get(metadata["name"])
            if record is None:
                continue
            if not record.description and metadata["description"]:
                record.description = metadata["description"]

            skill_path = str(skill_file.parent)
            if skill_path not in record.source_paths:
                record.source_paths.append(skill_path)

    skills = sorted(skills_by_name.values(), key=lambda skill: skill.name)
    for skill in skills:
        skill.source_paths.sort()
        skill.install_paths.sort()
        skill.installed_targets.sort()

    return SkillRegistrySnapshot(
        source_roots=source_roots,
        install_destinations=install_destinations,
        skills=skills,
    )


def _read_skill_metadata(skill_file: Path) -> dict[str, str | None]:
    skill_name = skill_file.parent.name
    description: str | None = None

    try:
        text = skill_file.read_text(encoding="utf-8")
    except OSError:
        return {"name": skill_name, "description": description}

    frontmatter_match = FRONTMATTER_RE.match(text)
    if frontmatter_match:
        for key, raw_value in FRONTMATTER_FIELD_RE.findall(frontmatter_match.group(1)):
            value = raw_value.strip().strip("'").strip('"')
            if key == "name" and value:
                skill_name = value
            elif key == "description" and value:
                description = value

    return {"name": skill_name, "description": description}
