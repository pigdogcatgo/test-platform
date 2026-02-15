import { evaluate } from 'mathjs';

/**
 * Parse answer expressions: "3/4", "√2", "√2/2", "2√3", "sqrt(2)/2", decimals, etc.
 */
export function parseAnswerToNumber(input) {
  if (input === undefined || input === null || input === '') return null;
  const s = String(input).trim();
  if (!s) return null;
  const expr = s
    .replace(/\u221A(\d+(?:\.\d+)?)/g, 'sqrt($1)')
    .replace(/\u221A\(([^)]+)\)/g, 'sqrt($1)')
    .replace(/(\d+(?:\.\d+)?)sqrt(\d+(?:\.\d+)?)/g, '$1*sqrt($2)') // 32sqrt22 -> 32*sqrt(22)
    .replace(/\bsqrt(\d+(?:\.\d+)?)/g, 'sqrt($1)'); // sqrt10 -> sqrt(10)
  try {
    const val = evaluate(expr);
    return typeof val === 'number' && !Number.isNaN(val) ? val : null;
  } catch {
    return null;
  }
}
