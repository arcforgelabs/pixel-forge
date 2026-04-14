// CalVer per SPECS.md REQ-S-014:
//   stable:     YYYY.M.D
//   correction: YYYY.M.D-N       (post-release, N >= 1, sorts after base)
//   prerelease: YYYY.M.D-beta.N  (N >= 1, sorts before base)

type CalverParts = {
  year: number;
  month: number;
  day: number;
  beta?: number;
  correction?: number;
};

const STABLE = /^(\d{4})\.([1-9]\d?)\.([1-9]\d?)$/;
const CORRECTION = /^(\d{4})\.([1-9]\d?)\.([1-9]\d?)-([1-9]\d*)$/;
const BETA = /^(\d{4})\.([1-9]\d?)\.([1-9]\d?)-beta\.([1-9]\d*)$/;

function parseCalver(value: string | null | undefined): CalverParts | null {
  if (!value) return null;
  const v = value.trim().replace(/^v/, "");

  const stable = STABLE.exec(v);
  if (stable) {
    return { year: Number(stable[1]), month: Number(stable[2]), day: Number(stable[3]) };
  }
  const beta = BETA.exec(v);
  if (beta) {
    return {
      year: Number(beta[1]),
      month: Number(beta[2]),
      day: Number(beta[3]),
      beta: Number(beta[4]),
    };
  }
  const correction = CORRECTION.exec(v);
  if (correction) {
    return {
      year: Number(correction[1]),
      month: Number(correction[2]),
      day: Number(correction[3]),
      correction: Number(correction[4]),
    };
  }
  return null;
}

function suffixRank(parts: CalverParts): number {
  if (parts.beta !== undefined) return -1;
  if (parts.correction !== undefined) return 1;
  return 0;
}

export function compareCalver(
  left: string | null | undefined,
  right: string | null | undefined
): number | null {
  const L = parseCalver(left);
  const R = parseCalver(right);
  if (!L || !R) return null;

  if (L.year !== R.year) return L.year > R.year ? 1 : -1;
  if (L.month !== R.month) return L.month > R.month ? 1 : -1;
  if (L.day !== R.day) return L.day > R.day ? 1 : -1;

  const lr = suffixRank(L);
  const rr = suffixRank(R);
  if (lr !== rr) return lr > rr ? 1 : -1;

  const lNum = L.beta ?? L.correction ?? 0;
  const rNum = R.beta ?? R.correction ?? 0;
  if (lNum === rNum) return 0;
  return lNum > rNum ? 1 : -1;
}

export function formatVersionLabel(value: string | null | undefined): string {
  if (!value || !value.trim()) return "unknown";
  const v = value.trim();
  return v.startsWith("v") ? v : `v${v}`;
}
