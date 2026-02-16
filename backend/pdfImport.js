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

  const systemPrompt = `You are a math competition problem processor. You will receive raw text extracted from a PDF. The formatting is often inconsistent: problems may be numbered as "1.", "17.", "Problem 1", "1) ", with varying spacing, underscores for answer blanks, page breaks, etc. Your job is to:
1. Identify and extract ALL math problems from the text
2. For each problem: convert to LaTeX (use $...$ and $$...$$ for math only), assign topics, and solve for the answer
3. Return a JSON array of objects: { "number": N, "questionLatex": "...", "topics": ["tag1", "tag2"], "answer": "numeric" }
4. Use "number" as the problem order (1, 2, 3, ...) based on appearance in the document
5. For "topics" use only from: [${tagList}]
6. In questionLatex, escape backslashes: write \\\\sqrt, \\\\frac (double backslash) so JSON parses correctly
7. Solve each problem and provide the numeric answer. If an answer key is provided, use those answers for matching problem numbers.

CRITICAL RULES:
- Write each problem EXACTLY word for word, character for character. Do not paraphrase, simplify, or "fix" the wording. Preserve the original problem text verbatim—changing even one word can make it a different problem.
- Dollar sign ($) starts LaTeX math mode. If the problem contains a literal dollar sign (e.g. "$7" for price, "costs $10"), you MUST escape it as \\\\$ so it displays correctly. Never use unescaped $ outside of math delimiters.
- For "not equal" use \\\\ne (not \\\\neq). For repeating decimals use \\\\overline{digits}, e.g. 0.\\\\overline{123} for 0.123 repeating.`;

  const userPrompt = `Extract all math problems from this raw PDF text. Handle any formatting - the document structure may be inconsistent.\n\n---\n\n${text}${answerKeyHint}`;

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let content = '[]';
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.2,
            responseMimeType: 'application/json',
          },
        });
        content = (response?.text || '').trim() || '[]';
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const errStr = String(err?.message || err?.toString?.() || err);
        const is404 = /NOT_FOUND|404|not found/i.test(errStr);
        const is429 = /RESOURCE_EXHAUSTED|quota|429|rate.?limit/i.test(errStr);
        if (is404) break; // try next model
        const retryDelay = is429 ? 60000 : 3000;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, retryDelay));
        } else {
          throw err;
        }
      }
    }
    if (!lastErr) break;
    if (lastErr && !/NOT_FOUND|404|not found/i.test(String(lastErr?.message || lastErr))) {
      throw lastErr;
    }
  }
  if (lastErr) throw lastErr;

  let arr;
  try {
    let jsonStr = content.replace(/^```json?\s*|\s*```$/g, '').trim();
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonStr = arrayMatch[0];
    // Fix LaTeX backslashes that break JSON parsing (AI often outputs \sqrt, \frac, \usepackage etc.)
    // 1. \u not followed by 4 hex digits (e.g. \usepackage, \unit) -> \\u
    jsonStr = jsonStr.replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u');
    // 2. \s, \c, \sqrt etc. - invalid single-char escapes -> \\X (valid: \" \\ \/ \b \f \n \r \t \uXXXX)
    jsonStr = jsonStr.replace(/\\([^"\\/bfnrtu])/g, '\\\\$1');
    try {
      arr = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Fallback: use jsonrepair for edge cases (trailing backslash, other bad escapes)
      jsonStr = jsonrepair(jsonStr);
      arr = JSON.parse(jsonStr);
    }
    if (!Array.isArray(arr)) arr = [arr];
  } catch (err) {
    throw new Error(`AI returned invalid JSON for batch. ${err.message}`);
  }

  const results = [];
  const batchErrors = [];
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
    // Fix LaTeX commands that don't render in KaTeX: \neq -> \ne
    question = question.replace(/\\neq\b/g, '\\ne');
    results.push({
      question,
      answer: answerNum !== null ? answerNum : 0,
      topics,
      source: `Problem ${num}`,
    });
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

  const text = await extractTextFromPdf(pdfBuffer);
  if (!text || text.length < 100) {
    throw new Error('Could not extract meaningful text from PDF. The file may be scanned/image-based.');
  }

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
