/**
 * Existing monetary rounding rules shared by pricing and evidence checks.
 */

export function ceilUsd(value) {
  return Math.ceil(Number(value) - 1e-9);
}

export function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}
