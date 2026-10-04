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

/** The candidate nearest to `from` in the direction, preferring one in line with it. */
export function nearestInDirection<T>(
  from: Point,
  [dx, dy]: Point,
  candidates: Iterable<T>,
  position: (candidate: T) => Point | undefined,
): T | undefined {
  const [x, y] = from;
  let best: T | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const at = position(candidate);
    if (!at) continue;
    const [cx, cy] = at;
    const ahead = (cx - x) * dx + (cy - y) * dy;
    const aside = Math.abs((cx - x) * dy) + Math.abs((cy - y) * dx);
    const score = ahead + 2 * aside;
    if (ahead > 0.5 && score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
