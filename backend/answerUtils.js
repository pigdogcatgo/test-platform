import { evaluate, parse } from 'mathjs';

const quotedAnswer = /^"([^"]*)"$|^'([^']*)'$/;
const arithmeticOperators = new Set(['add', 'subtract', 'multiply', 'divide', 'pow', 'unaryPlus', 'unaryMinus']);

function arithmeticValue(node) {
  if (node.isConstantNode && typeof node.value === 'number') return node.value;
  if (node.isParenthesisNode) return arithmeticValue(node.content);
  if (node.isSymbolNode && node.name === 'pi') return Math.PI;
  if (node.isFunctionNode && node.fn.isSymbolNode && node.args.length === 1) {
    if (node.fn.name === 'sqrt') return Math.sqrt(arithmeticValue(node.args[0]));
    if (node.fn.name === 'cbrt') return Math.cbrt(arithmeticValue(node.args[0]));
  }
  if (!node.isOperatorNode || !arithmeticOperators.has(node.fn)) throw new Error('Unsupported answer expression');
  const [left, right] = node.args.map(arithmeticValue);
  switch (node.fn) {
    case 'add': return left + right;
    case 'subtract': return left - right;
    case 'multiply': return left * right;
    case 'divide': return left / right;
    case 'pow': return left ** right;
    case 'unaryMinus': return -left;
    case 'unaryPlus': return left;
    default: throw new Error('Unsupported answer operator');
  }
}

function normalizeMathAnswer(input) {
  return String(input ?? '').trim().replaceAll('−', '-').replaceAll('⁄', '/')
    .replace(/\b\d{1,3}(?:,\d{3})+(?![\d,])/g, formatted => formatted.replaceAll(',', ''));
}

function mixedNumberParts(answer) {
  const match = /^([+-]?[1-9]\d*)\s+([1-9]\d*)\s*\/\s*([1-9]\d*)$/.exec(answer);
  if (!match || answer.length > 256 || !matchesAnswerFormat(`${match[2]}/${match[3]}`, 'reduced_fraction')) return null;
  const [whole, numerator, denominator] = match.slice(1).map(BigInt);
  return numerator < denominator ? [whole, numerator, denominator] : null;
}

export function matchesAnswerFormat(input, format = 'equivalent', decimals = null) {
  const answer = normalizeMathAnswer(input);
  if (!answer) return false;
  switch (format) {
    case 'equivalent':
    case 'exact_value':
    case 'exact_text':
      return true;
    case 'one_of':
      return true;
    case 'integer':
      return /^[+-]?(?:0|[1-9]\d*)$/.test(answer);
    case 'reduced_fraction': {
      const fraction = /^[+-]?(0|[1-9]\d*)\s*\/\s*([1-9]\d*)$/.exec(answer);
      if (!fraction || answer.length > 256) return false;
      let numerator = BigInt(fraction[1]);
      let denominator = BigInt(fraction[2]);
      if (denominator === 1n) return false;
      while (denominator > 0n) [numerator, denominator] = [denominator, numerator % denominator];
      return numerator === 1n;
    }
    case 'fixed_decimal': {
      const decimal = /^[+-]?(?:\d+)?\.(\d+)$/.exec(answer);
      return decimals === 0 ? matchesAnswerFormat(answer, 'integer') : decimal?.[1].length === decimals;
    }
    case 'scientific':
      return /^[+-]?[1-9](?:\.\d+)?(?:e[+-]?\d+|\s*[×*]\s*10\s*\^\s*[+-]?\d+)$/i.test(answer);
    case 'mixed_number':
      return mixedNumberParts(answer) !== null;
    default:
      return false;
  }
}

/**
 * Parse answer expressions: "3/4", "√2", "√2/2", "2√3", "sqrt(2)/2", decimals, etc.
 */
function parseCatalogAnswerToNumber(input) {
  if (input === undefined || input === null || input === '') return null;
  const s = normalizeMathAnswer(input);
  if (!s || s.length > 256) return null;
  const expr = s
    .replace(/π(?=\s*(?:√|∛|sqrt|cbrt|\())/g, 'pi*')
    .replaceAll('π', 'pi')
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replace(/\u221A(\d+(?:\.\d+)?)/g, 'sqrt($1)')
    .replace(/\u221A\(([^)]+)\)/g, 'sqrt($1)')
    .replace(/∛(\d+(?:\.\d+)?)/g, 'cbrt($1)')
    .replace(/∛\(([^)]+)\)/g, 'cbrt($1)')
    .replace(/(\d+(?:\.\d+)?)sqrt(\d+(?:\.\d+)?)/g, '$1*sqrt($2)') // 32sqrt22 -> 32*sqrt(22)
    .replace(/\bsqrt(\d+(?:\.\d+)?)/g, 'sqrt($1)'); // sqrt10 -> sqrt(10)
  try {
    const val = arithmeticValue(parse(expr));
    return Number.isFinite(val) ? val : null;
  } catch {
    return null;
  }
}

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
function parseOrderedPair(input, parseNumber = parseAnswerToNumber) {
  if (input === undefined || input === null || input === '') return null;
  const s = String(input).trim();
  const m = s.match(/^\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)\s*$/);
  if (!m) return null;
  const x = parseNumber(m[1].trim());
  const y = parseNumber(m[2].trim());
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
  // Fallback: accept any non-empty string (e.g. "Saturday", "N/A", "—") for teacher flexibility
  return s;
}

/**
 * Compare user answer with correct answer. Handles numeric (with tolerance),
 * string (case-insensitive), and ordered pair (both coordinates with tolerance).
 */
function compareLegacyAnswers(userInput, correctStored, tolerance) {
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

/**
 * Apply contest answer requirements when a format was reviewed with the source.
 * Existing catalog entries use the platform's original equivalent-value comparison.
 */
export function compareAnswers(userInput, correctStored, tolerance = 0.001, format = null, decimals = null, unit = null) {
  if (format == null) return compareLegacyAnswers(userInput, correctStored, tolerance);
  if (userInput === undefined || userInput === null || userInput === '') return false;
  let userStr = String(userInput).trim();
  if (!userStr) return false;
  if (unit) {
    const lower = userStr.toLowerCase();
    const label = unit.toLowerCase();
    if (label === '$' && userStr.startsWith('$')) userStr = userStr.slice(1).trim();
    else if (['floor', 'rung'].includes(label) && lower.startsWith(label + ' ')) userStr = userStr.slice(label.length).trim();
    else if (!['floor', 'rung', '$'].includes(label) && lower.endsWith(label)) userStr = userStr.slice(0, -label.length).trim();
  }

  let correctStr = correctStored === undefined || correctStored === null
    ? ''
    : String(correctStored).trim();
  const quotedCorrect = correctStr.match(quotedAnswer);
  if (quotedCorrect) {
    correctStr = (quotedCorrect[1] ?? quotedCorrect[2]).trim();
    const quotedUser = userStr.match(quotedAnswer);
    if (quotedUser) userStr = (quotedUser[1] ?? quotedUser[2]).trim();
  }

  if (!matchesAnswerFormat(userStr, format, decimals)) return false;
  if (format === 'exact_text') return userStr.toLowerCase() === correctStr.toLowerCase();
  if (format === 'one_of') {
    return correctStr.split(' or ').some(answer => answer.trim().toLowerCase() === userStr.toLowerCase());
  }
  if (format === 'mixed_number') {
    const userParts = mixedNumberParts(normalizeMathAnswer(userStr));
    const correctParts = mixedNumberParts(normalizeMathAnswer(correctStr));
    return correctParts !== null && userParts.every((part, index) => part === correctParts[index]);
  }
  if (format === 'integer' || (format === 'fixed_decimal' && decimals === 0)) {
    return matchesAnswerFormat(correctStr, 'integer')
      && BigInt(normalizeMathAnswer(userStr)) === BigInt(normalizeMathAnswer(correctStr));
  }
  if (format === 'reduced_fraction') {
    const [numerator, denominator] = normalizeMathAnswer(userStr).split('/').map(BigInt);
    if (matchesAnswerFormat(correctStr, format)) {
      const [correctNumerator, correctDenominator] = normalizeMathAnswer(correctStr).split('/').map(BigInt);
      return numerator * correctDenominator === correctNumerator * denominator;
    }
    return false;
  }
  if (format === 'fixed_decimal' || format === 'scientific' || format === 'exact_value') {
    const value = parseCatalogAnswerToNumber(userStr);
    const expected = parseCatalogAnswerToNumber(correctStr);
    return value !== null && expected !== null && Math.abs(value - expected) <= Number.EPSILON * Math.max(Math.abs(value), Math.abs(expected)) * 4;
  }

  const correctPair = parseOrderedPair(correctStr, parseCatalogAnswerToNumber);
  if (correctPair !== null) {
    const userPair = parseOrderedPair(userStr, parseCatalogAnswerToNumber);
    if (userPair === null) return false;
    return (
      Math.abs(userPair[0] - correctPair[0]) < tolerance &&
      Math.abs(userPair[1] - correctPair[1]) < tolerance
    );
  }

  if (!quotedCorrect) {
    const userNum = parseCatalogAnswerToNumber(userStr);
    const correctNum = parseCatalogAnswerToNumber(correctStr);
    if (userNum !== null && correctNum !== null) {
      return Math.abs(userNum - correctNum) < tolerance;
    }
  }

  return userStr.toLowerCase() === correctStr.toLowerCase();
}
