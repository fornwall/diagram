// Moving the keyboard focus between the items of a drawing in the direction of an arrow key, the
// same way in Mermaid diagrams and charts. Free of the DOM so that charts can be tested in Node.

/** A position in pixels: x to the right, y down. */
export type Point = readonly [x: number, y: number];

const DIRECTIONS: Partial<Record<string, Point>> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
};

/** The unit vector of an arrow key, or undefined for any other key. */
export const arrowDirection = (key: string): Point | undefined => DIRECTIONS[key];

/**
 * The candidate nearest to `from` in the direction, preferring one in line with it. Candidates at
 * the same place, such as repeated points of a scatter chart, follow each other in their order:
 * right and down lead to the next one, left and up to the previous one, and on past the last.
 */
export function nearestInDirection<T>(
  from: T,
  [dx, dy]: Point,
  candidates: Iterable<T>,
  position: (candidate: T) => Point | undefined,
  same: (a: T, b: T) => boolean = Object.is,
): T | undefined {
  const here = position(from);
  if (!here) return undefined;
  const [x, y] = here;
  const forward = dx + dy > 0;
  let passed = false;
  let best: T | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (same(candidate, from)) {
      passed = true;
      continue;
    }
    const at = position(candidate);
    if (!at) continue;
    const [cx, cy] = at;
    if (Math.abs(cx - x) <= 0.5 && Math.abs(cy - y) <= 0.5) {
      if (forward ? passed && bestScore >= 0 : !passed) {
        best = candidate;
        bestScore = -1;
      }
      continue;
    }
    const ahead = (cx - x) * dx + (cy - y) * dy;
    const aside = Math.abs((cx - x) * dy) + Math.abs((cy - y) * dx);
    const score = ahead + 2 * aside;
    // Of several at one place, enter at the first going forward, and at the last going back.
    if (ahead > 0.5 && (score < bestScore || (!forward && score === bestScore))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
