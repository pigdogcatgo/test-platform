/**
 * PDF Problem Import Service
 * Sends PDF directly to Gemini for extraction, or uses text parsing for no-AI mode.
 * Uses Google Gemini (free tier) - get API key at https://aistudio.google.com/app/apikey
 * Extracts diagrams from PDF pages when AI identifies them.
 */
import { PDFParse } from 'pdf-parse';
import { GoogleGenAI, createUserContent } from '@google/genai';
import { jsonrepair } from 'jsonrepair';
import pool from './db.js';
import { parseAnswerToNumber, parseAndValidateAnswer } from './answerUtils.js';

// Lazy-load pdfRender (requires canvas native module); diagram extraction is optional
let _renderPdfPageToPng = null;
async function getRenderPdfPageToPng() {
  if (_renderPdfPageToPng) return _renderPdfPageToPng;
  try {
    const pdfRender = await import('./pdfRender.js');
    _renderPdfPageToPng = pdfRender.renderPdfPageToPng;
    return _renderPdfPageToPng;
  } catch (_) {
    return null;
  }
}

const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

/**
 * Parse optional answer key text. Format: "1. 42" or "1) 3/4" or "1: 90000" (one per line).
 * Use quotes for string/ordered pair: 3. "Saturday" or 4. "(-1,-3)"
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
 * Refine problem regions using per-page images. The AI sees the actual rendered page
 * and returns regions, which is more accurate than inferring from the raw PDF.
 * @param {Buffer} pdfBuffer
 * @param {Array} processedList - from first pass, must have problemPage, problemRegion, number, hasDiagram
 * @param {Function} renderFn - renderPdfPageToPng
 * @returns {Promise<void>} - mutates processedList in place with refined problemRegion
 */
async function refineRegionsForImageMode(pdfBuffer, processedList, renderFn) {
  if (!ai || !renderFn || processedList.length === 0) return;
  const byPage = new Map();
  for (const p of processedList) {
    if (!p.problemPage) continue;
    const page = p.problemPage;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(p);
  }
  for (const [pageNum, problems] of byPage) {
    const nums = problems.map((p) => p.number).sort((a, b) => a - b);
    try {
      const pngBuffer = await renderFn(pdfBuffer, pageNum, null, 2, 0);
      const pageBase64 = pngBuffer.toString('base64');
      const prompt = `This image is page ${pageNum} of a math competition PDF. Problems on this page: ${nums.join(', ')}.

For EACH problem number, return the exact region that contains ONLY that problem.
CRITICAL: Use the problem NUMBER labels (1., 2., 3., etc.) to determine boundaries — NOT spacing or visual gaps. Problem N starts where "N." appears and ends where the next problem number appears (or end of page).
Coordinates: y = top edge (0 = top of page, 1 = bottom), h = height. Always use full width: x=0, w=1.
Return JSON: { "regions": [{ "number": N, "y": 0.0-1, "h": 0.0-1 }] }
Add small margin (0.01-0.02) above/below to avoid cutting off text. If a problem has a diagram, include the full diagram in its region.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: createUserContent([
          { text: prompt },
          { inlineData: { mimeType: 'image/png', data: pageBase64 } },
        ]),
        config: { temperature: 0, responseMimeType: 'application/json' },
      });
      const raw = (response?.text || '').trim();
      if (!raw) continue;
      let jsonStr = raw.replace(/^```json?\s*|\s*```$/g, '').trim();
      const objMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];
      let obj;
      try {
        obj = JSON.parse(jsonStr);
      } catch {
        obj = JSON.parse(jsonrepair(jsonStr));
      }
      const regions = obj?.regions || [];
      const regionByNum = Object.fromEntries(regions.map((r) => [r.number, r]));
      for (const p of problems) {
        const r = regionByNum[p.number];
        if (r && typeof r.y === 'number' && typeof r.h === 'number') {
          const y = Math.max(0, Math.min(1, r.y));
          const h = Math.max(0.02, Math.min(1 - y, r.h));
          p.problemRegion = { x: 0, y, w: 1, h };
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn('Region refinement failed for page', pageNum, err.message);
    }
  }
}

/**
 * Run verification pass: compare extracted problems with PDF, return corrections.
 */
async function runVerificationPass(pdfBuffer, extractedProblems, answerMap, allowedTagNames) {
  if (!ai || extractedProblems.length === 0) return {};
  const problemsJson = JSON.stringify(extractedProblems.map(p => ({
    number: p.number,
    questionLatex: p.question,
    answer: p.answer,
    topics: p.topics
  })));
  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');
  const verifyPrompt = `You are verifying extracted math problems against a PDF. Compare each extracted problem with the PDF. For any problem where the questionLatex does NOT match the PDF exactly (transcription errors, wrong symbols, paraphrasing, extra/missing text), return the corrected questionLatex.

Extracted problems:
${problemsJson}

Return JSON: { "corrections": [{ "number": N, "questionLatex": "corrected text matching PDF exactly" }] }
Only include problems that need correction. If all match, return { "corrections": [] }.
Use same LaTeX escaping: \\\\sqrt, \\\\frac, etc.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: createUserContent([
        { text: verifyPrompt },
        { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
      ]),
      config: { temperature: 0, responseMimeType: 'application/json' },
    });
    const raw = (response?.text || '').trim();
    if (!raw) return {};
    let jsonStr = raw.replace(/^```json?\s*|\s*```$/g, '').trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
    let obj;
    try {
      obj = JSON.parse(jsonStr);
    } catch {
      obj = JSON.parse(jsonrepair(jsonStr));
    }
    const corrections = obj?.corrections || [];
    return Object.fromEntries((corrections || []).map(c => [c.number, c.questionLatex]));
  } catch (err) {
    console.warn('Verification pass failed:', err.message);
    return {};
  }
}

/**
 * Send PDF directly to Gemini. One API call, no parsing or batching.
 * @param {object} opts - { useImageMode: boolean } when true, extract problem regions as images instead of LaTeX
 */
async function processPdfDirectWithAI(pdfBuffer, answerMap, allowedTagNames, opts = {}) {
  const useImageMode = opts.useImageMode === true;
  if (!ai) {
    throw new Error('GEMINI_API_KEY is required for PDF import. Get a free key at https://aistudio.google.com/app/apikey');
  }
  const tagList = allowedTagNames.length > 0 ? allowedTagNames.map(t => `"${t}"`).join(', ') : '"Arithmetic"';
  const answerKeyText = Object.entries(answerMap).map(([n, a]) => `${n}. ${a}`).join('\n');

  const imageModeInstructions = useImageMode ? `
IMAGE MODE: For each problem, return "problemPage" (1-based page number) and "problemRegion" { "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1 } — the bounding box on the page.
BOUNDARIES: Use the problem NUMBER (1., 2., 3., etc.) to determine where each problem starts and ends — NOT spacing or visual gaps. Problem N starts where "N." appears; it ends where the next problem number appears (or end of page). Do NOT rely on blank space between problems.
WIDTH: Every screenshot must be the full width of the PDF. Always use x=0 and w=1. Add small vertical margin (0.01-0.02) above/below if no diagram.
EXCEPTION: If the problem has a diagram (hasDiagram: true), the diagram MUST be fully included. When a problem has a diagram, problemRegion must encompass both the question text AND the complete diagram (still full width: x=0, w=1).
Set "questionLatex" to "Problem N" only. The system will screenshot each region.` : '';

  const systemPrompt = `You are a math competition problem processor. You will receive a PDF of a Sprint Round (or similar). Your job is to:
1. Extract EVERY problem from the Sprint Round section only. Do not include Target, Countdown, or other sections.
2. For each problem: convert to LaTeX (use $...$ and $$...$$ for math only), assign topics, and use the answer from the provided answer key.
3. Return a JSON object: { "folderName": "Year - Title - Round", "problems": [{ "number": N, "questionLatex": "...", "topics": ["tag1"], "answer": "numeric", "hasDiagram": boolean, "diagramPage": number?, "diagramRegion": { "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1 }? }] }
4. TAGS: You MUST use ONLY tags from this exact list — no exceptions: [${tagList}]. Use the exact spelling and casing (e.g. "Geometry" not "Geometric", "Algebra" not "algebraic"). Do NOT invent, create, or use variations of the same category.
5. In questionLatex, escape backslashes: write \\\\sqrt, \\\\frac (double backslash) so JSON parses correctly
6. Do NOT solve. Use the answer key values exactly for the "answer" field.
7. Extract folderName from the PDF header (e.g. "2021 - National Competition - Sprint Round").
8. DIAGRAMS: If a problem has a diagram, figure, or picture (geometry, graph, illustration), set "hasDiagram": true. Set "diagramPage" to the 1-based page number where the diagram appears. Optionally set "diagramRegion" with normalized coordinates (0-1) for the diagram area: x=left, y=top, w=width, h=height. If unsure of region, omit diagramRegion and the full page will be used. If no diagram, set "hasDiagram": false and omit diagramPage/diagramRegion.

CRITICAL: Copy each problem EXACTLY word for word. No paraphrasing. Use amsmath and amssymb commands (\\\\frac, \\\\sqrt, \\\\neq, \\\\leq, \\\\geq, \\\\sum, \\\\int, etc.). For "not equal" use \\\\ne. For literal $ use \\\\$.
TRANSCRIPTION: Preserve geometry labels exactly. "triangle GFD" not "triangle AGFD". "segment AB" not "segment AAB". Do not add extra letters to point/vertex names.${imageModeInstructions}`;

  const userPrompt = `Extract all math problems from this PDF. Use this answer key for answers (do not solve):

${answerKeyText}

For each problem's "topics" field, use ONLY these exact tag names (copy them character-for-character): ${tagList}. No variations or synonyms allowed.

For each problem that has a diagram/figure/picture, set "hasDiagram": true, "diagramPage": <1-based page number>, and optionally "diagramRegion": { "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1 } for the diagram's bounding box. If no diagram, set "hasDiagram": false.
${useImageMode ? 'IMAGE MODE: Every problem MUST have "problemPage" (1-based) and "problemRegion" { "x", "y", "w", "h" }. Use x=0 and w=1. Use the problem NUMBER (1., 2., 3.) to determine boundaries — problem N starts at "N." and ends at the next number. Do NOT use spacing or gaps. If the problem has a diagram, the diagram MUST be fully included.' : ''}

Return JSON: { "folderName": "...", "problems": [...] }`;

  const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');

  const models = ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-flash'];
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
      return parseAIResponse(raw, answerMap, allowedTagNames, useImageMode);
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

/**
 * Resolve AI tag to an existing allowed tag. Uses case-insensitive exact match,
 * then checks for same-category variants (e.g. "Geometric" -> "Geometry", "algebraic" -> "Algebra").
 * Never returns a new tag — always maps to an allowed one.
 */
function resolveToAllowedTag(aiTag, allowedTagNames) {
  if (!aiTag || typeof aiTag !== 'string') return allowedTagNames[0] || 'Arithmetic';
  const n = aiTag.trim();
  if (!n) return allowedTagNames[0] || 'Arithmetic';
  const lower = n.toLowerCase();
  const exact = allowedTagNames.find((a) => a.trim().toLowerCase() === lower);
  if (exact) return exact;
  const variant = allowedTagNames.find((a) => {
    const al = a.trim().toLowerCase();
    if (al.length < 4 || lower.length < 4) return false;
    return al.includes(lower) || lower.includes(al) ||
      (lower.length >= 5 && al.length >= 5 && (al.startsWith(lower.slice(0, 5)) || lower.startsWith(al.slice(0, 5))));
  });
  return variant || allowedTagNames[0] || 'Arithmetic';
}

function parseAIResponse(rawContent, answerMap, allowedTagNames = ['Algebra', 'Number Theory', 'Counting', 'Geometry', 'Probability', 'Arithmetic'], useImageMode = false) {
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
  const defaultTag = allowedTagNames[0] || 'Arithmetic';
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const num = item?.number ?? i + 1;
    const answer = answerMap[num] !== undefined ? String(answerMap[num]) : (item.answer || '');
    const answerVal = parseAndValidateAnswer(answer);
    if (answerVal === null && answer !== '') {
      errors.push({ number: num, message: `Invalid answer for problem ${num}: "${answer}"` });
      continue;
    }
    let topics = item.topics;
    if (!Array.isArray(topics)) topics = item.topic ? [item.topic] : [defaultTag];
    let question = (item.questionLatex || item.question || '').trim();
    if (useImageMode) question = `Problem ${num}`;
    if (!question) continue;
    question = question.replace(/\\neq\b/g, '\\ne');
    question = question.replace(/(\b(?:cost|costs|spent)\s+)\\(\d+)/gi, '$1\\$$2');
    const aiTopic = topics.find((t) => t && String(t).trim()) || defaultTag;
    const tag = resolveToAllowedTag(aiTopic, allowedTagNames);
    const answerStored = answerMap[num] !== undefined && answer.trim()
      ? answer.trim()
      : (answerVal !== null ? (typeof answerVal === 'number' ? String(answerVal) : answerVal) : '0');
    const hasDiagram = Boolean(item.hasDiagram && item.diagramPage);
    const diagramPage = hasDiagram ? Math.max(1, parseInt(item.diagramPage, 10) || 1) : null;
    const diagramRegion = hasDiagram && item.diagramRegion && typeof item.diagramRegion === 'object'
      ? item.diagramRegion
      : null;
    const problemPage = item.problemPage != null ? Math.max(1, parseInt(item.problemPage, 10) || 1) : null;
    const problemRegion = problemPage && item.problemRegion && typeof item.problemRegion === 'object'
      ? item.problemRegion
      : null;
    results.push({ number: num, question, answer: answerStored, topics: [tag], source: `Problem ${num}`, hasDiagram, diagramPage, diagramRegion, problemPage, problemRegion });
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
  const tagNames = ['Algebra', 'Arithmetic', 'Counting', 'Geometry', 'Number Theory', 'Probability'];
  const tagMap = {};
  for (const name of tagNames) {
    const existing = await client.query('SELECT id FROM tags WHERE name = $1', [name]);
    if (existing.rows[0]) {
      tagMap[name] = existing.rows[0].id;
    } else {
      try {
        const r = await client.query(
          'INSERT INTO tags (name, is_system, created_by) VALUES ($1, true, NULL) RETURNING id',
          [name]
        );
        if (r.rows[0]) tagMap[name] = r.rows[0].id;
      } catch (err) {
        const retry = await client.query('SELECT id FROM tags WHERE name = $1', [name]);
        tagMap[name] = retry.rows[0]?.id;
      }
    }
  }
  return tagMap;
}

function processProblemNoAI(problem, answerFromKey) {
  if (answerFromKey === undefined) throw new Error(`Answer key required for problem ${problem.number} (no-AI mode)`);
  const raw = String(answerFromKey).trim();
  const answerVal = parseAndValidateAnswer(raw);
  if (answerVal === null) throw new Error(`Invalid answer for problem ${problem.number}: "${answerFromKey}"`);
  const answerStored = raw;
  return { question: problem.raw, answer: answerStored, topic: 'Arithmetic', source: `Problem ${problem.number}` };
}

/**
 * Main import: send PDF to Gemini (AI) or parse text (no-AI).
 * @param {Buffer} pdfBuffer
 * @param {string} answerKeyText
 * @param {boolean} useAI
 * @param {number|null} createdBy - user id for teacher-owned; null for admin/public
 * @param {object} opts - { useImageMode: boolean, runVerification: boolean }
 */
export async function importPdfToDatabase(pdfBuffer, answerKeyText = '', useAI = true, createdBy = null, opts = {}) {
  const useImageMode = opts.useImageMode === true;
  const runVerification = opts.runVerification !== false;
  const errors = [];
  const answerMap = parseAnswerKey(answerKeyText);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureTags(client, createdBy);
    const SYSTEM_TAG_NAMES = ['Algebra', 'Arithmetic', 'Counting', 'Geometry', 'Number Theory', 'Probability'];
    const allTags = await client.query(
      'SELECT id, name FROM tags WHERE name = ANY($1::text[]) ORDER BY name',
      [SYSTEM_TAG_NAMES]
    );
    const tagMap = Object.fromEntries(allTags.rows.map((r) => [r.name, r.id]));
    const allowedTagNames = allTags.rows.map((r) => r.name).length > 0
      ? allTags.rows.map((r) => r.name)
      : SYSTEM_TAG_NAMES;
    const defaultTag = allowedTagNames[0] || 'Arithmetic';
    let imported = 0;
    let sourceName = 'Imported from PDF';
    let folderId;

    if (useAI) {
      if (Object.keys(answerMap).length === 0) {
        throw new Error('Answer key is required for AI import. Paste answers (one per line): 1. 42, 2. 3/4, etc.');
      }
      let { folderName, results: processedList, errors: batchErrors } = await processPdfDirectWithAI(pdfBuffer, answerMap, allowedTagNames, { useImageMode });
      sourceName = folderName;
      for (const err of batchErrors) errors.push(err.message);

      if (useImageMode && processedList.length > 0) {
        const renderFn = await getRenderPdfPageToPng();
        if (renderFn) await refineRegionsForImageMode(pdfBuffer, processedList, renderFn);
      }

      if (runVerification && !useImageMode && processedList.length > 0) {
        const corrections = await runVerificationPass(pdfBuffer, processedList, answerMap, allowedTagNames);
        if (Object.keys(corrections).length > 0) {
          for (const p of processedList) {
            if (corrections[p.number]) {
              p.question = corrections[p.number];
            }
          }
        }
      }
      let folderRow = await client.query('SELECT id FROM folders WHERE name = $1 AND (created_by IS NOT DISTINCT FROM $2)', [sourceName, createdBy]);
      if (folderRow.rows.length === 0) folderRow = await client.query('INSERT INTO folders (name, created_by) VALUES ($1, $2) RETURNING id', [sourceName, createdBy]);
      folderId = folderRow.rows[0].id;
      for (const processed of processedList) {
        const tagName = (processed.topics[0] || defaultTag).trim();
        const validTag = allowedTagNames.includes(tagName) ? tagName : defaultTag;
        let imageUrl = null;
        const renderFn = await getRenderPdfPageToPng();
        if (renderFn) {
          if (useImageMode && processed.problemPage) {
            try {
              let region = processed.problemRegion;
              if (region && typeof region === 'object') {
                const y = Math.max(0, Math.min(1, Number(region.y) || 0));
                const h = Math.max(0.02, Math.min(1 - y, Number(region.h) || 0.2));
                region = { x: 0, y, w: 1, h };
              }
              const cropPad = processed.hasDiagram ? 0.08 : 0.04;
              const pngBuffer = await renderFn(pdfBuffer, processed.problemPage, region, 2, cropPad);
              const base64 = pngBuffer.toString('base64');
              const uploadRes = await client.query(
                'INSERT INTO uploads (data, filename, content_type, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
                [base64, `problem-${processed.number}.png`, 'image/png', createdBy]
              );
              imageUrl = '/uploads/db/' + uploadRes.rows[0].id;
            } catch (renderErr) {
              console.warn('Problem image extraction failed for problem', processed.number, renderErr.message);
            }
          } else if (!useImageMode && processed.hasDiagram && processed.diagramPage) {
            try {
              const pngBuffer = await renderFn(pdfBuffer, processed.diagramPage, processed.diagramRegion);
              const base64 = pngBuffer.toString('base64');
              const uploadRes = await client.query(
                'INSERT INTO uploads (data, filename, content_type, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
                [base64, `problem-${processed.number}-diagram.png`, 'image/png', createdBy]
              );
              imageUrl = '/uploads/db/' + uploadRes.rows[0].id;
            } catch (renderErr) {
              console.warn('Diagram extraction failed for problem', processed.number, renderErr.message);
            }
          }
        }
        const ins = await client.query(
          'INSERT INTO problems (question, answer, topic, image_url, source, folder_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [processed.question, String(processed.answer), validTag, imageUrl, processed.source, folderId, createdBy]
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
            [processed.question, String(processed.answer), 'Arithmetic', processed.source, folderId, createdBy]
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
