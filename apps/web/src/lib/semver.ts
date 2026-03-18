function parseSemver(value: string | null | undefined): [number, number, number] | null {
  if (!value) {
    return null;
  }

  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(
  left: string | null | undefined,
  right: string | null | undefined
): number | null {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  if (!leftParts || !rightParts) {
    return null;
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }
    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
  }

  return 0;
}

export function formatVersionLabel(value: string | null | undefined): string {
  if (!value || !value.trim()) {
    return "unknown";
  }
  return value.trim().startsWith("v") ? value.trim() : `v${value.trim()}`;
}
