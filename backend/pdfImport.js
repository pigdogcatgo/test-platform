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
 */
export function splitIntoProblems(text) {
  const problems = [];
  const regex = /^(\d+)\.\s+/gm;
  let match;
  let lastIndex = 0;
  let lastNum = 0;

  while ((match = regex.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    const start = match.index;
    if (lastNum > 0) {
      const raw = text.slice(lastIndex, start).trim();
      if (raw.length > 10) problems.push({ number: lastNum, raw });
    }
    lastNum = num;
    lastIndex = start;
  }
  if (lastNum > 0) {
    const raw = text.slice(lastIndex).trim();
    // Trim footer/copyright
    const footer = /Copyright\s+.*?\.\s*All rights reserved.*$/is;
    const cleaned = raw.replace(footer, '').trim();
    if (cleaned.length > 10) problems.push({ number: lastNum, raw: cleaned });
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

const BATCH_SIZE = 50; // All problems in one call (Gemini 1.5 has 1M context)

/**
 * Process a batch of problems in one API call. Reduces requests from N to ceil(N/5).
 * @param {string[]} allowedTagNames - Only these tags may be used; AI must pick from this list.
 */
async function processBatchWithAI(batch, answerMap, allowedTagNames) {
  if (!ai) {
    throw new Error('GEMINI_API_KEY is required for PDF import. Get a free key at https://aistudio.google.com/app/apikey');
  }
  const tagList = allowedTagNames.length > 0 ? allowedTagNames.join('", "') : 'Arithmetic';
  const systemPrompt = `You are a math competition problem processor. Output a JSON array with one object per problem. Each: { "number": N, "questionLatex": "LaTeX with $...$ and $$...$$", "topics": ["tag1", "tag2"], "answer": "numeric" }. For "topics" use an array of one or more tags from: ${tagList}. Use multiple tags when a problem fits multiple categories (e.g. geometric probability: ["Geometry", "Probability"]). Only use listed tags. In questionLatex JSON strings, escape backslashes: write \\\\sqrt, \\\\frac (double backslash) so JSON parses correctly. Preserve problem text; only convert math to LaTeX. Use the provided answer when given. Return exactly ${batch.length} objects in order.`;

  const parts = batch.map((p) => {
    const ans = answerMap[p.number];
    return `Problem ${p.number}:\n${p.raw}\n${ans !== undefined ? `Answer: ${ans}` : 'Solve and provide answer.'}`;
  });
  const userPrompt = parts.join('\n\n---\n\n');

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
  for (let i = 0; i < batch.length; i++) {
    const prob = batch[i];
    const item = arr[i] || arr.find((x) => x.number === prob.number) || {};
    const answer = answerMap[prob.number] !== undefined ? String(answerMap[prob.number]) : (item.answer || '');
    const answerNum = parseAnswerToNumber(answer);
    if (answerNum === null && answer !== '') {
      throw new Error(`Invalid answer for problem ${prob.number}: "${answer}"`);
    }
    let topics = item.topics;
    if (!Array.isArray(topics)) {
      topics = item.topic ? [item.topic] : ['Arithmetic'];
    }
    results.push({
      question: item.questionLatex || prob.raw,
      answer: answerNum !== null ? answerNum : 0,
      topics,
      source: `Problem ${prob.number}`,
    });
  }
  return results;
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
  if (problems.length === 0) {
    throw new Error('No problems found in PDF. Expected format: "1. Question text..."');
  }

  if (!useAI && Object.keys(answerMap).length === 0) {
    throw new Error('Answer key is required when not using AI. Paste answers in format: 1. 42, 2. 3/4, etc.');
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
      for (let i = 0; i < problems.length; i += BATCH_SIZE) {
        const batch = problems.slice(i, i + BATCH_SIZE);
        if (i > 0) await new Promise((r) => setTimeout(r, 7000));
        try {
          const processedList = await processBatchWithAI(batch, answerMap, allowedTagNames);
          for (let j = 0; j < batch.length; j++) {
            const processed = processedList[j];
            const prob = batch[j];
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
          for (const p of batch) errors.push(`Problem ${p.number}: ${err.message}`);
        }
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
