// Arithmetic that charts share: sums without floating-point leftovers, quantiles and round steps.

/** The decimals of a number as written out in full: 2 for 0.25, 7 for 1e-7, 0 for 1e21. */
function decimalsOf(value: number): number {
  const [digits = "", exponent = "0"] = String(value).split("e");
  return Math.max(0, (digits.split(".")[1]?.length ?? 0) - Number(exponent));
}

/**
 * A sum of numbers that shows no more decimals than they have, as 0.3 for 0.1 + 0.2 rather than
 * 0.30000000000000004, and 0 for 0.1 + 0.2 - 0.3. Compensation retains small values lost when
 * adding numbers of different magnitudes; decimal rounding happens only once finished.
 */
export class Sum {
  private exact = 0;
  private correction = 0;
  private decimals = 0;

  add(value: number | Sum): this {
    if (value instanceof Sum) {
      const { exact, correction, decimals } = value;
      this.accumulate(exact);
      this.accumulate(correction);
      this.decimals = Math.max(this.decimals, decimals);
    } else {
      this.accumulate(value);
      this.decimals = Math.max(this.decimals, decimalsOf(value));
    }
    return this;
  }

  private accumulate(value: number): void {
    const next = this.exact + value;
    this.correction +=
      Math.abs(this.exact) >= Math.abs(value)
        ? this.exact - next + value
        : value - next + this.exact;
    if (!Number.isFinite(next + this.correction)) {
      throw new Error(
        "The chart's total exceeds the numeric range. Rescale the values before charting them.",
      );
    }
    this.exact = next;
  }

  get value(): number {
    const total = this.exact + this.correction;
    // Beyond what toFixed writes out, a number has no leftovers to round off.
    return this.decimals > 20 || Math.abs(total) >= 1e21
      ? total
      : Number(total.toFixed(this.decimals));
  }
}

/** A number worked out by division, such as a mean, to 12 significant digits, without leftovers. */
export const withoutNoise = (value: number) =>
  Number.isInteger(value) ? value : Number(value.toPrecision(12));

/** The quantile of sorted numbers, interpolating between them, as R's default quantile does. */
export function quantile(sorted: number[], share: number): number {
  const at = (sorted.length - 1) * share;
  const below = Math.floor(at);
  const left = sorted[below] ?? 0;
  return interpolate(left, sorted[below + 1] ?? left, at - below);
}

/** The number a fraction of the way from `left` to `right`. */
export function interpolate(left: number, right: number, fraction: number): number {
  // Weighted interpolation avoids overflow when opposite signs make the difference infinite.
  const difference = right - left;
  return Number.isFinite(difference)
    ? left + difference * fraction
    : left * (1 - fraction) + right * fraction;
}

/** The smallest of 1, 2 or 5 times a power of ten that is at least a positive value. */
export function roundStep(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  // The tolerance allows for rounding in the logarithm and the power, as for 0.3.
  return (
    [1, 2, 5].map((factor) => factor * power).find((round) => round >= value * 0.999999) ??
    10 * power
  );
}

/**
 * Counts steps of `step` to a value, and back. Multiples of a fraction's inverse, 3 / 10 for 0.3,
 * are exact where 3 * 0.1 is not.
 */
export function stepsOf(step: number): { count(value: number): number; at(steps: number): number } {
  const inverse = step < 1 ? Math.round(1 / step) : undefined;
  return inverse === undefined
    ? { count: (value) => value / step, at: (steps) => steps * step }
    : { count: (value) => value * inverse, at: (steps) => steps / inverse };
}
