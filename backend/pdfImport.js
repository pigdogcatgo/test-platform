/**
 * PDF Problem Import Service
 * Extracts problems from competition PDFs, uses AI for LaTeX conversion, topic tagging, and answer extraction.
 */
import { PDFParse } from 'pdf-parse';
import OpenAI from 'openai';
import pool from './db.js';
import { parseAnswerToNumber } from './answerUtils.js';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

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

/**
 * Use OpenAI to process a single problem: LaTeX, topic, answer (if not in key).
 */
async function processProblemWithAI(problem, answerFromKey) {
  if (!openai) {
    throw new Error('OPENAI_API_KEY is required for PDF import. Set it in your .env file.');
  }

  const systemPrompt = `You are a math competition problem processor. For each problem, output valid JSON only, no markdown:
{
  "questionLatex": "question text with LaTeX: use $...$ for inline math, $$...$$ for display. Convert fractions as \\frac{a}{b}, sqrt as \\sqrt{x}, exponents as x^2.",
  "topic": "one of: Algebra, Number Theory, Counting, Geometry, Probability, Arithmetic",
  "answer": "numeric answer: integer, decimal, fraction like 3/4, or radical like sqrt(2)/2 or 2*sqrt(3). Simplify fully."
}
Rules: Preserve the problem statement exactly; only convert math to LaTeX. Topic must be exactly one of the listed options.`;

  const userPrompt = `Problem ${problem.number}:\n${problem.raw}\n\n${
    answerFromKey !== undefined
      ? `The answer is: ${answerFromKey}. Use this exact value for "answer".`
      : 'Solve the problem and provide the answer.'
  }`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
  });

  const content = completion.choices[0]?.message?.content?.trim() || '{}';
  let parsed;
  try {
    const jsonStr = content.replace(/^```json?\s*|\s*```$/g, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`AI returned invalid JSON for problem ${problem.number}`);
  }

  const answer = answerFromKey !== undefined ? String(answerFromKey) : (parsed.answer || '');
  const answerNum = parseAnswerToNumber(answer);
  if (answerNum === null && answer !== '') {
    throw new Error(`Invalid answer for problem ${problem.number}: "${answer}"`);
  }

  return {
    question: parsed.questionLatex || problem.raw,
    answer: answerNum !== null ? answerNum : 0,
    topic: parsed.topic || 'Arithmetic',
    source: `Problem ${problem.number}`,
  };
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
 * Main import: parse PDF, process with AI, insert into DB.
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} [answerKeyText] - Optional answer key (e.g. "1. 42\n2. 3/4")
 * @returns {{ imported: number, folderId: number, folderName: string, errors: string[] }}
 */
export async function importPdfToDatabase(pdfBuffer, answerKeyText = '') {
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create or get folder
    let folderRow = await client.query('SELECT id FROM folders WHERE name = $1', [sourceName]);
    if (folderRow.rows.length === 0) {
      folderRow = await client.query('INSERT INTO folders (name) VALUES ($1) RETURNING id', [sourceName]);
    }
    const folderId = folderRow.rows[0].id;

    const tagMap = await ensureTags(client);
    let imported = 0;

    for (const prob of problems) {
      try {
        const answerFromKey = answerMap[prob.number];
        const processed = await processProblemWithAI(prob, answerFromKey);

        const tagName = processed.topic in TOPIC_TAGS ? TOPIC_TAGS[processed.topic] : processed.topic;
        const tagId = tagMap[tagName] || tagMap['Arithmetic'];

        const ins = await client.query(
          `INSERT INTO problems (question, answer, topic, source, folder_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [processed.question, processed.answer, tagName, processed.source, folderId]
        );
        const problemId = ins.rows[0].id;
        if (tagId) {
          await client.query(
            'INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [problemId, tagId]
          );
        }
        imported++;
      } catch (err) {
        errors.push(`Problem ${prob.number}: ${err.message}`);
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
