/**
 * PDF Problem Import Service
 * Sends PDF directly to Gemini for extraction, or uses text parsing for no-AI mode.
 * Uses Google Gemini (free tier) - get API key at https://aistudio.google.com/app/apikey
 */
import { PDFParse } from 'pdf-parse';
import { GoogleGenAI, createUserContent } from '@google/genai';
import { jsonrepair } from 'jsonrepair';
import pool from './db.js';
import { parseAnswerToNumber } from './answerUtils.js';

const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

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
 * Send PDF directly to Gemini. One API call, no parsing or batching.
 */
async function processPdfDirectWithAI(pdfBuffer, answerMap, allowedTagNames) {
  if (!ai) {
    throw new Error('GEMINI_API_KEY is required for PDF import. Get a free key at https://aistudio.google.com/app/apikey');
  }
  const tagList = allowedTagNames.length > 0 ? allowedTagNames.map(t => `"${t}"`).join(', ') : '"Arithmetic"';
  const answerKeyText = Object.entries(answerMap).map(([n, a]) => `${n}. ${a}`).join('\n');

  const systemPrompt = `You are a math competition problem processor. You will receive a PDF of a Sprint Round (or similar). Your job is to:
1. Extract EVERY problem from the Sprint Round section only. Do not include Target, Countdown, or other sections.
2. For each problem: convert to LaTeX (use $...$ and $$...$$ for math only), assign topics, and use the answer from the provided answer key.
3. Return a JSON object: { "folderName": "Year - Title - Round", "problems": [{ "number": N, "questionLatex": "...", "topics": ["tag1"], "answer": "numeric" }] }
4. For "topics" use only from: [${tagList}]
5. In questionLatex, escape backslashes: write \\\\sqrt, \\\\frac (double backslash) so JSON parses correctly
6. Do NOT solve. Use the answer key values exactly for the "answer" field.
7. Extract folderName from the PDF header (e.g. "2021 - National Competition - Sprint Round").

CRITICAL: Copy each problem EXACTLY word for word. No paraphrasing. Use amsmath and amssymb commands (\\\\frac, \\\\sqrt, \\\\neq, \\\\leq, \\\\geq, \\\\sum, \\\\int, etc.). For "not equal" use \\\\ne. For literal $ use \\\\$.`;

  const userPrompt = `Extract all math problems from this PDF. Use this answer key for answers (do not solve):

${answerKeyText}

Return JSON: { "folderName": "...", "problems": [...] }`;

  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-flash'];
  let lastErr;
  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: createUserContent([
          { text: userPrompt },
          { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
        ]),
        config: { systemInstruction: systemPrompt, temperature: 0, responseMimeType: 'application/json' },
      });
      const raw = (response?.text || '').trim();
      if (!raw) throw new Error('Empty response from AI');
      return parseAIResponse(raw, answerMap);
    } catch (err) {
      lastErr = err;
      const errStr = String(err?.message || err?.toString?.() || err);
      if (/NOT_FOUND|404|not found/i.test(errStr)) continue;
      if (/RESOURCE_EXHAUSTED|quota|429|rate.?limit/i.test(errStr)) {
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('AI processing failed');
}

function parseAIResponse(rawContent, answerMap) {
  let jsonStr = rawContent.replace(/^```json?\s*|\s*```$/g, '').trim();
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) jsonStr = objMatch[0];
  try {
    var obj = JSON.parse(jsonStr);
  } catch {
    jsonStr = jsonrepair(jsonStr);
    obj = JSON.parse(jsonStr);
  }
  const problems = obj?.problems || obj;
  const arr = Array.isArray(problems) ? problems : [problems];
  const folderName = obj?.folderName || 'Imported from PDF';
  const results = [];
  const errors = [];
  const allowedTagNames = ['Algebra', 'Number Theory', 'Counting', 'Geometry', 'Probability', 'Arithmetic'];
  const defaultTag = 'Arithmetic';
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const num = item?.number ?? i + 1;
    const answer = answerMap[num] !== undefined ? String(answerMap[num]) : (item.answer || '');
    const answerNum = parseAnswerToNumber(answer);
    if (answerNum === null && answer !== '') {
      errors.push({ number: num, message: `Invalid answer for problem ${num}: "${answer}"` });
      continue;
    }
    let topics = item.topics;
    if (!Array.isArray(topics)) topics = item.topic ? [item.topic] : [defaultTag];
    let question = (item.questionLatex || item.question || '').trim();
    if (!question) continue;
    question = question.replace(/\\neq\b/g, '\\ne');
    question = question.replace(/(\b(?:cost|costs|spent)\s+)\\(\d+)/gi, '$1\\$$2');
    const tag = topics.find((t) => allowedTagNames.includes(t)) || defaultTag;
    results.push({ number: num, question, answer: answerNum !== null ? answerNum : 0, topics: [tag], source: `Problem ${num}` });
  }
  return { folderName, results, errors };
}

/**
 * Extract plain text from a PDF buffer (for no-AI mode only).
 */
export async function extractTextFromPdf(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  await parser.destroy();
  return result.text || '';
}

/**
 * Extract source/folder name from PDF header.
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
    if (/^\d{4}\s*$/.test(line)) { year = line.trim(); continue; }
    if (/^(Sprint|Target|Team|Countdown)\s/i.test(line)) { round = line; continue; }
    if (/^Problems\s+\d/i.test(line) && !round) round = line;
    if (line.length >= 10 && !/^\d+\./.test(line) && !title) title = line.replace(/\s+/g, ' ').trim();
  }
  const parts = [year, title, round].filter(Boolean).map((s) => s.trim());
  return parts.length > 0 ? parts.join(' - ') : 'Imported from PDF';
}

/**
 * Split text into individual problems by number pattern (for no-AI mode only).
 */
export function splitIntoProblems(text) {
  if (!text || typeof text !== 'string') return [];
  let normalized = text.replace(/\r\n|\r|\f/g, '\n');
  normalized = normalized.replace(/(?:^|\n)\s*[Pp]roblem\s+(\d+)([\.\)\:])\s*/g, '\n$1$2 ');
  const problems = [];
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
      if (raw.length > 10) { seq++; problems.push({ number: seq, raw }); }
    }
    lastNum = num;
    lastIndex = start;
  }
  if (lastNum > 0) {
    const raw = normalized.slice(lastIndex).trim();
    const cleaned = raw.replace(/Copyright\s+.*?\.\s*All rights reserved.*$/is, '').trim();
    if (cleaned.length > 10) { seq++; problems.push({ number: seq, raw: cleaned }); }
  }
  return problems;
}

async function ensureTags(client, createdBy) {
  const tagNames = ['Algebra', 'Number Theory', 'Counting', 'Geometry', 'Probability', 'Arithmetic'];
  const tagMap = {};
  for (const name of tagNames) {
    try {
      if (createdBy === null) {
        const r = await client.query(
          'INSERT INTO tags (name, created_by) VALUES ($1, NULL) RETURNING id',
          [name]
        );
        if (r.rows[0]) tagMap[name] = r.rows[0].id;
      } else {
        const r = await client.query(
          'INSERT INTO tags (name, created_by) VALUES ($1, $2) RETURNING id',
          [name, createdBy]
        );
        if (r.rows[0]) tagMap[name] = r.rows[0].id;
      }
    } catch (err) {
      if (err.code === '23505') {
        const existing = await client.query(
          'SELECT id FROM tags WHERE name = $1 AND (created_by IS NOT DISTINCT FROM $2)',
          [name, createdBy]
        );
        tagMap[name] = existing.rows[0]?.id;
      } else throw err;
    }
  }
  return tagMap;
}

function processProblemNoAI(problem, answerFromKey) {
  if (answerFromKey === undefined) throw new Error(`Answer key required for problem ${problem.number} (no-AI mode)`);
  const answerNum = parseAnswerToNumber(String(answerFromKey));
  if (answerNum === null) throw new Error(`Invalid answer for problem ${problem.number}: "${answerFromKey}"`);
  return { question: problem.raw, answer: answerNum, topic: 'Arithmetic', source: `Problem ${problem.number}` };
}

/**
 * Main import: send PDF to Gemini (AI) or parse text (no-AI).
 * @param {Buffer} pdfBuffer
 * @param {string} answerKeyText
 * @param {boolean} useAI
 * @param {number|null} createdBy - user id for teacher-owned; null for admin/public
 */
export async function importPdfToDatabase(pdfBuffer, answerKeyText = '', useAI = true, createdBy = null) {
  const errors = [];
  const answerMap = parseAnswerKey(answerKeyText);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureTags(client, createdBy);
    const allTags = createdBy === null
      ? await client.query('SELECT id, name FROM tags WHERE created_by IS NULL ORDER BY name')
      : await client.query('SELECT id, name FROM tags WHERE created_by IS NULL OR created_by = $1 ORDER BY name', [createdBy]);
    const tagMap = Object.fromEntries(allTags.rows.map((r) => [r.name, r.id]));
    const allowedTagNames = allTags.rows.map((r) => r.name);
    const defaultTag = allowedTagNames[0] || 'Arithmetic';
    let imported = 0;
    let sourceName = 'Imported from PDF';
    let folderId;

    if (useAI) {
      if (Object.keys(answerMap).length === 0) {
        throw new Error('Answer key is required for AI import. Paste answers (one per line): 1. 42, 2. 3/4, etc.');
      }
      const { folderName, results: processedList, errors: batchErrors } = await processPdfDirectWithAI(pdfBuffer, answerMap, allowedTagNames);
      sourceName = folderName;
      for (const err of batchErrors) errors.push(err.message);
      let folderRow = await client.query('SELECT id FROM folders WHERE name = $1 AND (created_by IS NOT DISTINCT FROM $2)', [sourceName, createdBy]);
      if (folderRow.rows.length === 0) folderRow = await client.query('INSERT INTO folders (name, created_by) VALUES ($1, $2) RETURNING id', [sourceName, createdBy]);
      folderId = folderRow.rows[0].id;
      for (const processed of processedList) {
        const tagName = (processed.topics[0] || defaultTag).trim();
        const validTag = allowedTagNames.includes(tagName) ? tagName : defaultTag;
        const ins = await client.query(
          'INSERT INTO problems (question, answer, topic, source, folder_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [processed.question, processed.answer, validTag, processed.source, folderId, createdBy]
        );
        const tagId = tagMap[validTag];
        if (tagId) await client.query('INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ins.rows[0].id, tagId]);
        imported++;
      }
    } else {
      const text = await extractTextFromPdf(pdfBuffer);
      if (!text || text.length < 100) throw new Error('Could not extract text from PDF. The file may be scanned/image-based.');
      const nextSection = /(?:Target Round|Countdown Round|Team Round|\n\d{4}\s*\n\s*Mock)/i;
      const idx = text.search(nextSection);
      const trimmedText = idx > 500 ? text.slice(0, idx) : text;
      sourceName = extractSourceName(trimmedText);
      const problems = splitIntoProblems(trimmedText);
      if (problems.length === 0) throw new Error('No problems found in PDF. Expected format: "1. Question text..."');
      if (Object.keys(answerMap).length === 0) throw new Error('Answer key is required when not using AI.');
      let folderRow = await client.query('SELECT id FROM folders WHERE name = $1 AND (created_by IS NOT DISTINCT FROM $2)', [sourceName, createdBy]);
      if (folderRow.rows.length === 0) folderRow = await client.query('INSERT INTO folders (name, created_by) VALUES ($1, $2) RETURNING id', [sourceName, createdBy]);
      folderId = folderRow.rows[0].id;
      for (const prob of problems) {
        try {
          const processed = processProblemNoAI(prob, answerMap[prob.number]);
          const ins = await client.query(
            'INSERT INTO problems (question, answer, topic, source, folder_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [processed.question, processed.answer, 'Arithmetic', processed.source, folderId, createdBy]
          );
          const tagId = tagMap[defaultTag];
          if (tagId) await client.query('INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ins.rows[0].id, tagId]);
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
