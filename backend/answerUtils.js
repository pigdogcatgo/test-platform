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
 * Parse and validate an answer. Supports:
 * - Numeric: 42, 3/4, √2, etc.
 * - Quoted string/ordered pair: "Saturday" or "(-1,-3)" — wrap in double quotes to treat as non-numeric
 * Returns: number | string | string "(x,y)" for ordered pair, or null if invalid.
 */
export function parseAndValidateAnswer(input) {
  if (input === undefined || input === null) return null;
  let s = String(input).trim();
  if (!s) return null;

  // Quoted: "Saturday" or "(-1,-3)" — teacher indicates non-numeric by wrapping in quotes
  const quotedMatch = s.match(/^"([^"]*)"$|^'([^']*)'$/);
  if (quotedMatch) {
    const inner = (quotedMatch[1] ?? quotedMatch[2] ?? '').trim();
    if (!inner) return null;
    const pair = parseOrderedPair(inner);
    if (pair !== null) return `(${pair[0]},${pair[1]})`;
    return inner;
  }

  // Non-quoted: try numeric first
  const pair = parseOrderedPair(s);
  if (pair !== null) return `(${pair[0]},${pair[1]})`;
  const num = parseAnswerToNumber(s);
  if (num !== null) return num;
  return null;
}

/**
 * Compare user answer with correct answer. Handles numeric (with tolerance),
 * string (case-insensitive), and ordered pair (both coordinates with tolerance).
 */
export function compareAnswers(userInput, correctStored, tolerance = 0.001) {
  if (userInput === undefined || userInput === null || userInput === '') return false;
  const userStr = String(userInput).trim();
  if (!userStr) return false;

  const correctStr = correctStored === undefined || correctStored === null
    ? ''
    : String(correctStored).trim();

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

  const userNum = parseAnswerToNumber(userStr);
  const correctNum = parseAnswerToNumber(correctStr);
  if (userNum !== null && correctNum !== null) {
    return Math.abs(userNum - correctNum) < tolerance;
  }

  return userStr.toLowerCase() === correctStr.toLowerCase();
}
