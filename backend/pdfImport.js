/**
 * PDF Problem Import Service
 * Extracts problems from competition PDFs, uses AI for LaTeX conversion, topic tagging, and answer extraction.
 * Uses Google Gemini (free tier) - get API key at https://aistudio.google.com/app/apikey
 */
import { PDFParse } from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';
import { jsonrepair } from 'jsonrepair';
import pool from './db.js';
import { parseAnswerToNumber } from './answerUtils.js';

const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

const TOPIC_TAGS = {
  algebra: 'Algebra',
  'number theory': 'Number Theory',
  combinatorics: 'Counting',
  counting: 'Counting',
  geometry: 'Geometry',
  probability: 'Probability',
  arithmetic: 'Arithmetic',
};

/**
 * Extract plain text from a PDF buffer.
 */
export async function extractTextFromPdf(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  await parser.destroy();
  return result.text || '';
}

/**
 * Extract source/folder name from PDF header (first ~600 chars).
 * Looks for patterns like "2021 Mock AoPS Mock National Competition Sprint Round"
 */
export function extractSourceName(text) {
  const head = text.slice(0, 700);
  const lines = head.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const skip = /^(HONOR|I pledge|DO NOT|This section|Signature|Printed|Total Correct|LATEX|Test-solved|FOUNDING|Copyright|\d+-\d+)$/i;
  let year = '';
  let title = '';
  let round = '';
  for (const line of lines) {
    if (skip.test(line) || line.length < 3) continue;
    if (/^\d{4}\s*$/.test(line)) {
      year = line.trim();
      continue;
    }
    if (/^(Sprint|Target|Team|Countdown)\s/i.test(line)) {
      round = line;
      continue;
    }
    if (/^Problems\s+\d/i.test(line) && !round) round = line;
    if (line.length >= 10 && !/^\d+\./.test(line) && !title) {
      title = line.replace(/\s+/g, ' ').trim();
    }
  }
  const parts = [year, title, round].filter(Boolean).map((s) => s.trim());
  return parts.length > 0 ? parts.join(' - ') : 'Imported from PDF';
}

/**
 * Split text into individual problems by number pattern (1. 2. 3. ...).
 * Uses sequential numbering (1, 2, 3, ...) so answer key "1. 42" = first problem.
 * Matches "N. ", "N) ", "N: " at line start. Handles "Problem N." format and relaxed spacing.
 */
export function splitIntoProblems(text) {
  if (!text || typeof text !== 'string') return [];
  // Normalize: \r\n, \r, form-feed -> \n; helps with PDF extraction quirks
  let normalized = text.replace(/\r\n|\r|\f/g, '\n');
  // Convert "Problem 17." or "problem 17)" at line start to "17." so main regex matches
  normalized = normalized.replace(/(?:^|\n)\s*[Pp]roblem\s+(\d+)([\.\)\:])\s*/g, '\n$1$2 ');
  const problems = [];
  // Match N. N) N: at line start; \s* allows "17.Question" (no space); \s* between num and delimiter for "17 ."
  const regex = /^\s*(\d+)\s*[\.\)\:]\s*/gm;
  let match;
  let lastIndex = 0;
  let lastNum = 0;
  let seq = 0;

  while ((match = regex.exec(normalized)) !== null) {
    const num = parseInt(match[1], 10);
    const start = match.index;
    if (lastNum > 0) {
      const raw = normalized.slice(lastIndex, start).trim();
      if (raw.length > 10) {
        seq++;
        problems.push({ number: seq, raw });
      }
    }
    lastNum = num;
    lastIndex = start;
  }
  if (lastNum > 0) {
    const raw = normalized.slice(lastIndex).trim();
    const footer = /Copyright\s+.*?\.\s*All rights reserved.*$/is;
    const cleaned = raw.replace(footer, '').trim();
    if (cleaned.length > 10) {
      seq++;
      problems.push({ number: seq, raw: cleaned });
    }
  }
  return problems;
}

/**
 * Strip LaTeX to get comparable plain text for fidelity check.
 */
function stripLatexForCompare(s) {
  if (!s || typeof s !== 'string') return '';
  let t = s
    .replace(/\$\$[^$]*\$\$|\$[^$]*\$/g, ' ')
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '$1/$2')
    .replace(/\\sqrt\{([^}]*)\}/g, 'sqrt($1)')
    .replace(/\\overline\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  return t;
}

/**
 * Extract critical content (numbers, Circle X, etc.) for fidelity check.
 */
function extractCritical(text) {
  const normalized = stripLatexForCompare(text);
  const numbers = new Set();
  (normalized.match(/\d+(?:\.\d+)?/g) || []).forEach((n) => numbers.add(n));
  const circleMatches = text.match(/Circle\s+([A-Z])/gi) || [];
  const circles = new Set(circleMatches.map((m) => m.replace(/\s+/g, ' ').toLowerCase()));
  const words = new Set((normalized.match(/\b[a-z0-9]{2,}\b/g) || []).filter((w) => w.length >= 2));
  return { numbers, circles, words };
}

/**
 * Non-AI check: does AI output preserve critical content from source?
 * Returns array of warning strings, empty if OK.
 */
function validateFidelity(sourceRaw, aiOutput, problemNum) {
  const warnings = [];
  if (!sourceRaw || !aiOutput) return warnings;
  const src = extractCritical(sourceRaw);
  const out = extractCritical(aiOutput);
  for (const c of src.circles) {
    const letter = c.replace('circle ', '').trim();
    const outCircles = [...out.circles].map((x) => x.replace('circle ', '').trim());
    if (!outCircles.includes(letter)) {
      const wrong = outCircles.filter((x) => x !== letter);
      if (wrong.length > 0) {
        warnings.push(`Problem ${problemNum}: source has "Circle ${letter}" but output has "Circle ${wrong[0]}"`);
      } else {
        warnings.push(`Problem ${problemNum}: source has "Circle ${letter}" but it's missing in output`);
      }
    }
  }
  const srcWords = [...src.words].filter((w) => w.length >= 3);
  const overlap = srcWords.filter((w) => out.words.has(w)).length;
  const ratio = srcWords.length > 0 ? overlap / srcWords.length : 1;
  if (ratio < 0.6) {
    warnings.push(`Problem ${problemNum}: low word overlap (${Math.round(ratio * 100)}%) - possible paraphrase`);
  }
  const srcNums = [...src.numbers].filter((n) => n.length >= 1);
  const missingNums = srcNums.filter((n) => !out.numbers.has(n) && !aiOutput.includes(n));
  if (missingNums.length > srcNums.length * 0.3) {
    warnings.push(`Problem ${problemNum}: many numbers from source missing in output`);
  }
  return warnings;
}

/**
 * Parse optional answer key text. Format: "1. 42" or "1) 3/4" or "1: 90000" (one per line)
 */
export function parseAnswerKey(text) {
  if (!text || typeof text !== 'string') return {};
  const map = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)[\.\)\:]\s*(.+)$/);
    if (m) {
      const num = parseInt(m[1], 10);
      const ans = m[2].trim().replace(/\s+/g, ' ');
      if (ans) map[num] = ans;
    }
  }
  return map;
}

/**
 * Process full PDF text with AI - no regex split. AI extracts problems on its own,
 * handling inconsistent formatting (1., 17., Problem 1, etc.).
 */
async function processFullTextWithAI(text, answerMap, allowedTagNames) {
  if (!ai) {
    throw new Error('GEMINI_API_KEY is required for PDF import. Get a free key at https://aistudio.google.com/app/apikey');
  }
  const tagList = allowedTagNames.length > 0 ? allowedTagNames.map(t => `"${t}"`).join(', ') : '"Arithmetic"';
  const answerKeyHint = Object.keys(answerMap).length > 0
    ? `\n\nAnswer key (use these when the problem number matches):\n${Object.entries(answerMap).map(([n, a]) => `${n}. ${a}`).join('\n')}`
    : '';

  const systemPrompt = `You are a math competition problem processor. You will receive raw text from the FIRST section of a PDF only (e.g. Sprint Round). Your job is to:
1. Extract EVERY problem from this section—Sprint Round has 30 problems. Count them. Do not skip any.
2. For each problem: convert to LaTeX (use $...$ and $$...$$ for math only), assign topics, and solve for the answer
3. Return a JSON array of objects: { "number": N, "questionLatex": "...", "topics": ["tag1", "tag2"], "answer": "numeric" }
4. Use "number" as 1, 2, 3, ... in order. Do not include problems from other sections (Target, Countdown, or a different competition).
5. For "topics" use only from: [${tagList}]
6. In questionLatex, escape backslashes: write \\\\sqrt, \\\\frac (double backslash) so JSON parses correctly
7. Solve each problem and provide the numeric answer. If an answer key is provided, use those answers for matching problem numbers.

CRITICAL RULES:
- Write each problem EXACTLY word for word, character for character. Do not paraphrase, simplify, or "fix" the wording. Preserve the original problem text verbatim—changing even one word can make it a different problem.
- ZERO TYPOS. No approximations, no "close enough" substitutions. One wrong character invalidates the problem. Proofread each problem against the source text before including it.
- Dollar sign ($) starts LaTeX math mode. To display a literal dollar sign (e.g. for prices), the LaTeX command is \\\\$ — so "cost \$7" in LaTeX. In your JSON output, write "cost \\\\$7". NEVER write \\\\7 or \\\\8—that is wrong. The command is always \\\\$ followed by the number.
- Never change variable names, labels, or circle names. If the problem says "Circle D" or "centers A and D", do NOT write "Circle B". If it says "m³/n³ = 3³/4³", do NOT change to "m/n = 0" or any other form.
- Keep numbers, coordinates, and variables IN the sentence where they belong. "A line passes through the points (3,-1), (5,5) and (9,m)" must stay as one coherent sentence. Do not split coordinates into separate fragments.
- For "not equal" use \\\\ne (not \\\\neq). For repeating decimals use \\\\overline{digits}, e.g. 0.\\\\overline{123} for 0.123 repeating.`;

  const baseUserPrompt = `Extract all math problems from this raw PDF text. Handle any formatting - the document structure may be inconsistent. Copy each problem character-for-character from the source; do not introduce any typos or changes.\n\n---\n\n${text}${answerKeyHint}`;

  const callAI = async (prompt) => {
    const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-pro', 'gemini-1.5-pro'];
    let out = '[]';
    let lastErr;
    for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: { systemInstruction: systemPrompt, temperature: 0, responseMimeType: 'application/json' },
          });
          out = (response?.text || '').trim() || '[]';
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const errStr = String(err?.message || err?.toString?.() || err);
          const is404 = /NOT_FOUND|404|not found/i.test(errStr);
          const is429 = /RESOURCE_EXHAUSTED|quota|429|rate.?limit/i.test(errStr);
          if (is404) break;
          if (is429 && attempt >= 2) break;
          await new Promise((r) => setTimeout(r, is429 ? 20000 : 2000));
          if (attempt >= 2) throw err;
        }
      }
      if (!lastErr) break;
      const tryNext = /NOT_FOUND|404|RESOURCE_EXHAUSTED|quota|429/i.test(String(lastErr?.message || lastErr || ''));
      if (!tryNext) throw lastErr;
    }
    if (lastErr) throw lastErr;
    return out;
  };

  const parseContentToResults = (rawContent) => {
    let jsonStr = rawContent.replace(/^```json?\s*|\s*```$/g, '').trim();
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonStr = arrayMatch[0];
    jsonStr = jsonStr.replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u');
    jsonStr = jsonStr.replace(/\\([^"\\/bfnrtu])/g, '\\\\$1');
    try {
      var arr = JSON.parse(jsonStr);
    } catch {
      jsonStr = jsonrepair(jsonStr);
      arr = JSON.parse(jsonStr);
    }
    if (!Array.isArray(arr)) arr = [arr];
    return arr;
  };

  const sourceProblems = splitIntoProblems(text);
  const MAX_CORRECTIONS = 1; // Keep within Render free tier 5-min limit
  let content = await callAI(baseUserPrompt);
  let results = [];
  let batchErrors = [];
  let fidelityWarnings = [];

  for (let correctionAttempt = 0; correctionAttempt <= MAX_CORRECTIONS; correctionAttempt++) {
    let arr;
    try {
      arr = parseContentToResults(content);
    } catch (err) {
      throw new Error(`AI returned invalid JSON for batch. ${err.message}`);
    }

    results = [];
    batchErrors = [];
    fidelityWarnings = [];
    const items = Array.isArray(arr) ? arr : [arr];
    for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const num = item?.number ?? i + 1;
    const answer = answerMap[num] !== undefined ? String(answerMap[num]) : (item.answer || '');
    const answerNum = parseAnswerToNumber(answer);
    if (answerNum === null && answer !== '') {
      batchErrors.push({ number: num, message: `Invalid answer for problem ${num}: "${answer}"` });
      continue;
    }
    let topics = item.topics;
    if (!Array.isArray(topics)) {
      topics = item.topic ? [item.topic] : ['Arithmetic'];
    }
    let question = (item.questionLatex || item.question || '').trim();
    if (!question) continue;
    // Fix LaTeX: \neq -> \ne
    question = question.replace(/\\neq\b/g, '\\ne');
    // Fix common AI mistake: "cost \7" should be "cost \$7" (literal dollar for price)
    question = question.replace(/(\b(?:cost|costs|spent)\s+)\\(\d+)/gi, '$1\\$$2');
    results.push({
      number: num,
      question,
      answer: answerNum !== null ? answerNum : 0,
      topics,
      source: `Problem ${num}`,
    });
  }
    if (sourceProblems.length > results.length) {
      batchErrors.push({
        number: 0,
        message: `Expected ${sourceProblems.length} problems from source but AI returned ${results.length}. Some problems may be missing.`,
      });
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const src = sourceProblems[i];
      if (src?.raw && r) {
        const warns = validateFidelity(src.raw, r.question, r.number);
        for (const w of warns) fidelityWarnings.push(w);
      }
    }

    if (fidelityWarnings.length === 0 || correctionAttempt >= MAX_CORRECTIONS) {
      for (const w of fidelityWarnings) batchErrors.push({ number: 0, message: w });
      break;
    }

    const correctivePrompt = `${baseUserPrompt}\n\n---\n\nCORRECTION NEEDED: Your output had these fidelity issues. Fix the indicated problems to match the source text exactly, and return the complete corrected JSON array. Keep all other problems unchanged.\n\nIssues:\n${fidelityWarnings.join('\n')}`;
    await new Promise((r) => setTimeout(r, 500));
    content = await callAI(correctivePrompt);
  }

  return { results, errors: batchErrors };
}

/**
 * Ensure tags exist and return id by name.
 */
async function ensureTags(client) {
  const tagNames = ['Algebra', 'Number Theory', 'Counting', 'Geometry', 'Probability', 'Arithmetic'];
  const tagMap = {};
  for (const name of tagNames) {
    const r = await client.query(
      'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id',
      [name]
    );
    if (r.rows[0]) {
      tagMap[name] = r.rows[0].id;
    } else {
      const existing = await client.query('SELECT id FROM tags WHERE name = $1', [name]);
      tagMap[name] = existing.rows[0]?.id;
    }
  }
  return tagMap;
}

/**
 * Process a problem without AI: raw text, answer from key required.
 */
function processProblemNoAI(problem, answerFromKey) {
  if (answerFromKey === undefined) {
    throw new Error(`Answer key required for problem ${problem.number} (no-AI mode)`);
  }
  const answerNum = parseAnswerToNumber(String(answerFromKey));
  if (answerNum === null) {
    throw new Error(`Invalid answer for problem ${problem.number}: "${answerFromKey}"`);
  }
  return {
    question: problem.raw,
    answer: answerNum,
    topic: 'Arithmetic',
    source: `Problem ${problem.number}`,
  };
}

/**
 * Main import: parse PDF, process with or without AI, insert into DB.
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} [answerKeyText] - Answer key (required for no-AI mode)
 * @param {boolean} [useAI=true] - If false, skip AI; requires answer key for every problem
 * @returns {{ imported: number, folderId: number, folderName: string, errors: string[] }}
 */
export async function importPdfToDatabase(pdfBuffer, answerKeyText = '', useAI = true) {
  const errors = [];
  const answerMap = parseAnswerKey(answerKeyText);

  let text = await extractTextFromPdf(pdfBuffer);
  if (!text || text.length < 100) {
    throw new Error('Could not extract meaningful text from PDF. The file may be scanned/image-based.');
  }
  // Only use the FIRST competition section. Stop at Target Round, Countdown, or a new year's competition.
  const nextSection = /(?:Target Round|Countdown Round|Team Round|\n\d{4}\s*\n\s*Mock)/i;
  const idx = text.search(nextSection);
  if (idx > 500) text = text.slice(0, idx);

  const sourceName = extractSourceName(text);
  const problems = splitIntoProblems(text);

  if (!useAI) {
    if (problems.length === 0) {
      throw new Error('No problems found in PDF. Expected format: "1. Question text..."');
    }
    if (Object.keys(answerMap).length === 0) {
      throw new Error('Answer key is required when not using AI. Paste answers in format: 1. 42, 2. 3/4, etc.');
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create or get folder
    let folderRow = await client.query('SELECT id FROM folders WHERE name = $1', [sourceName]);
    if (folderRow.rows.length === 0) {
      folderRow = await client.query('INSERT INTO folders (name) VALUES ($1) RETURNING id', [sourceName]);
    }
    const folderId = folderRow.rows[0].id;

    await ensureTags(client);
    const allTags = await client.query('SELECT id, name FROM tags ORDER BY name');
    const tagMap = Object.fromEntries(allTags.rows.map((r) => [r.name, r.id]));
    const allowedTagNames = allTags.rows.map((r) => r.name);
    const defaultTag = allowedTagNames[0] || 'Arithmetic';
    let imported = 0;

    if (useAI) {
      try {
        const { results: processedList, errors: batchErrors } = await processFullTextWithAI(text, answerMap, allowedTagNames);
        for (const err of batchErrors) errors.push(err.message);
        for (const processed of processedList) {
            const tagNames = (processed.topics || [defaultTag])
              .map((t) => (typeof t === 'string' ? t : String(t)).trim())
              .filter((t) => allowedTagNames.includes(t));
            if (tagNames.length === 0) tagNames.push(defaultTag);
            const ins = await client.query(
              `INSERT INTO problems (question, answer, topic, source, folder_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [processed.question, processed.answer, tagNames[0], processed.source, folderId]
            );
            const problemId = ins.rows[0].id;
            for (const tagName of tagNames) {
              const tagId = tagMap[tagName];
              if (tagId) {
                await client.query(
                  'INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                  [problemId, tagId]
                );
              }
            }
            imported++;
          }
        } catch (err) {
          errors.push(err.message || 'AI processing failed');
        }
    } else {
      for (const prob of problems) {
        try {
          const answerFromKey = answerMap[prob.number];
          const processed = processProblemNoAI(prob, answerFromKey);
          const tagId = tagMap[defaultTag];
          const ins = await client.query(
            `INSERT INTO problems (question, answer, topic, source, folder_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [processed.question, processed.answer, 'Arithmetic', processed.source, folderId]
          );
          if (tagId) {
            await client.query(
              'INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [ins.rows[0].id, tagId]
            );
          }
          imported++;
        } catch (err) {
          errors.push(`Problem ${prob.number}: ${err.message}`);
        }
      }
    }

    await client.query('COMMIT');
    return { imported, folderId, folderName: sourceName, errors };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
