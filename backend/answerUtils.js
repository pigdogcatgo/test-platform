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

/**
 * Try to parse an ordered pair like (-1, -3), (1, 2), (1/2, -3/4).
 * Returns [x, y] if valid, null otherwise.
 */
function parseOrderedPair(input) {
  if (input === undefined || input === null || input === '') return null;
  const s = String(input).trim();
  const m = s.match(/^\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)\s*$/);
  if (!m) return null;
  const x = parseAnswerToNumber(m[1].trim());
  const y = parseAnswerToNumber(m[2].trim());
  if (x === null || y === null) return null;
  return [x, y];
}

/**
 * Parse and validate an answer. Returns a normalized value suitable for storage:
 * - number for numeric answers
 * - string for text answers (e.g. "Saturday")
 * - string "(x,y)" for ordered pairs (normalized format)
 * Returns null if invalid.
 */
export function parseAndValidateAnswer(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;

  // 1. Try ordered pair first (before numeric, since "(-1,-3)" could be ambiguous)
  const pair = parseOrderedPair(s);
  if (pair !== null) {
    return `(${pair[0]},${pair[1]})`;
  }

  // 2. Try numeric
  const num = parseAnswerToNumber(s);
  if (num !== null) {
    return num;
  }

  // 3. Treat as string (non-empty, not purely whitespace)
  return s;
}

/**
 * Compare user answer with correct answer. Handles numeric (with tolerance),
 * string (case-insensitive), and ordered pair (both coordinates with tolerance).
 * @param {string|number} userInput - raw user input
 * @param {string|number} correctStored - stored correct answer (number, string, or "(x,y)")
 * @param {number} tolerance - for numeric/ordered pair comparison (default 0.001)
 */
export function compareAnswers(userInput, correctStored, tolerance = 0.001) {
  if (userInput === undefined || userInput === null || userInput === '') {
    return false;
  }
  const userStr = String(userInput).trim();
  if (!userStr) return false;

  // Normalize correct answer: DB may store number as string "42" or numeric 42
  const correctStr = correctStored === undefined || correctStored === null
    ? ''
    : String(correctStored).trim();

  // Ordered pair: correct is "(x,y)" format
  if (correctStr.startsWith('(') && correctStr.includes(',') && correctStr.endsWith(')')) {
    const userPair = parseOrderedPair(userStr);
    if (userPair === null) return false;
    const correctPair = parseOrderedPair(correctStr);
    if (correctPair === null) return false;
    return (
      Math.abs(userPair[0] - correctPair[0]) < tolerance &&
      Math.abs(userPair[1] - correctPair[1]) < tolerance
    );
  }

  // Numeric: try parsing both
  const userNum = parseAnswerToNumber(userStr);
  const correctNum = parseAnswerToNumber(correctStr);
  if (userNum !== null && correctNum !== null) {
    return Math.abs(userNum - correctNum) < tolerance;
  }

  // String: case-insensitive comparison
  return userStr.toLowerCase() === correctStr.toLowerCase();
}
