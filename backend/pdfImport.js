/**
 * PDF Problem Import Service
 * Sends PDF directly to Gemini for extraction, or uses text parsing for no-AI mode.
 * Uses Google Gemini (free tier) - get API key at https://aistudio.google.com/app/apikey
 * Extracts diagrams from PDF pages when AI identifies them.
 */
import { PDFParse } from 'pdf-parse';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { GoogleGenAI, createUserContent } from '@google/genai';
import { jsonrepair } from 'jsonrepair';
import pool from './db.js';
import { cleanupStaleUnreferencedUploads, insertImageUpload } from './storageLimits.js';
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
export const MAX_PDF_PAGES = 60;
const MAX_IMAGE_REFINEMENT_PAGES = 10;

export async function assertPdfPageLimit(pdfBuffer) {
  const loadingTask = getDocument({ data: new Uint8Array(pdfBuffer) });
  let pdf;
  try {
    pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      const error = new Error(`PDF contains ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES} pages`);
      error.status = 413;
      throw error;
    }
  } finally {
    if (pdf) await pdf.destroy().catch(() => {});
    else await loadingTask.destroy().catch(() => {});
  }
}

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
 * Retry region for a single problem (when teacher rejects screenshot).
 * Uses getRenderPdfPageToPng internally so render is always available.
 * @param {number} [attempt] - 1-based attempt number, used to vary the prompt
 * @param {string} [direction] - "up" | "down" - teacher says region should move up or down
 */
export async function retryRegionForProblem(pdfBuffer, processed, attempt = 1, direction = null) {
  if (!ai || !processed.problemPage) return false;
  const renderFn = await getRenderPdfPageToPng();
  if (!renderFn) return false;
  const pageNum = processed.problemPage;
  const num = processed.number;
  const prev = processed.problemRegion;
  const dirHint = direction === 'up'
    ? ' The teacher says to move the screenshot higher up on the page. Use a SMALLER y value.'
    : direction === 'down'
      ? ' The teacher says to move the screenshot down on the page. Use a LARGER y value or extend the height.'
      : '';
  try {
    const pngBuffer = await renderFn(pdfBuffer, pageNum, null, 2, 0);
    const pageBase64 = pngBuffer.toString('base64');
    const attemptHint = attempt > 1 ? ` (Attempt ${attempt} - try a noticeably different region)` : '';
    const prompt = `This image is page ${pageNum} of a math competition PDF. The previous crop for problem ${num} was WRONG.
${prev ? `Previous region was approximately y=${(prev.y || 0).toFixed(2)}, h=${(prev.h || 0).toFixed(2)}.` : ''}
${dirHint}

Return a DIFFERENT region for problem ${num} only. Adjust the vertical boundaries.${attemptHint}
Coordinates: y = top edge (0 = top, 1 = bottom), h = height. Use x=0, w=1 (full width).
Return JSON: { "regions": [{ "number": ${num}, "y": 0.0-1, "h": 0.0-1 }] }`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: createUserContent([
        { text: prompt },
        { inlineData: { mimeType: 'image/png', data: pageBase64 } },
      ]),
      config: { temperature: 0.5, responseMimeType: 'application/json' },
    });
    const raw = (response?.text || '').trim();
    if (!raw) return false;
    let jsonStr = raw.replace(/^```json?\s*|\s*```$/g, '').trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
    const obj = JSON.parse(jsonrepair(jsonStr));
    const regions = obj?.regions || [];
    const r = regions.find((x) => x.number === num);
    if (r && typeof r.y === 'number' && typeof r.h === 'number') {
      const y = Math.max(0, Math.min(1, r.y));
      const h = Math.max(0.02, Math.min(1 - y, r.h));
      processed.problemRegion = { x: 0, y, w: 1, h };
      return true;
    }
  } catch (err) {
    console.warn('Retry region failed for problem', num, err.message);
  }
  const fallbackPrev = processed.problemRegion;
  if (fallbackPrev && typeof fallbackPrev.y === 'number' && typeof fallbackPrev.h === 'number') {
    const y = fallbackPrev.y;
    const h = fallbackPrev.h;
    let pick;
    if (direction === 'up') {
      pick = { y: Math.max(0, y - 0.08), h: Math.min(1 - Math.max(0, y - 0.08), h + 0.06) };
    } else if (direction === 'down') {
      const yNew = Math.min(1 - 0.02, y + 0.06);
      pick = { y: yNew, h: Math.max(0.02, Math.min(1 - yNew, h + 0.04)) };
    } else {
      const offsets = [
        { y: Math.max(0, y - 0.06), h: Math.min(1 - Math.max(0, y - 0.06), h + 0.08) },
        { y: Math.min(1 - 0.02, y + 0.04), h: Math.max(0.02, h - 0.04) },
        { y: Math.max(0, y - 0.03), h: Math.max(0.02, h - 0.02) },
      ];
      pick = offsets[Math.min(attempt - 1, offsets.length - 1)];
    }
    processed.problemRegion = { x: 0, y: pick.y, w: 1, h: pick.h };
    return true;
  }
  return false;
}

/**
 * Render a single problem's screenshot to base64.
 */
export async function renderProblemScreenshot(pdfBuffer, processed) {
  const renderFn = await getRenderPdfPageToPng();
  if (!renderFn || !processed.problemPage) return null;
  let region = processed.problemRegion;
  if (region && typeof region === 'object') {
    const y = Math.max(0, Math.min(1, Number(region.y) || 0));
    const h = Math.max(0.02, Math.min(1 - y, Number(region.h) || 0.2));
    region = { x: 0, y, w: 1, h };
  }
  const cropPad = processed.hasDiagram ? 0.08 : 0.04;
  const pngBuffer = await renderFn(pdfBuffer, processed.problemPage, region, 2, cropPad);
  return pngBuffer.toString('base64');
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
  let refinedPages = 0;
  for (const [pageNum, problems] of byPage) {
    if (refinedPages >= MAX_IMAGE_REFINEMENT_PAGES) {
      // Keep the initial AI regions for remaining pages. If one is missing,
      // renderProblemScreenshot naturally falls back to the full page.
      continue;
    }
    refinedPages++;
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
9. For every problem, set "problemPage" to the 1-based page number where that problem begins.
10. Set "continuationPages" to any additional 1-based pages needed to read the full problem, including a diagram on another page. Omit it when no other page is needed.

CRITICAL: Copy each problem EXACTLY word for word. No paraphrasing. Use amsmath and amssymb commands (\\\\frac, \\\\sqrt, \\\\neq, \\\\leq, \\\\geq, \\\\sum, \\\\int, etc.). For "not equal" use \\\\ne. For literal $ use \\\\$.
TRANSCRIPTION: Preserve geometry labels exactly. "triangle GFD" not "triangle AGFD". "segment AB" not "segment AAB". Do not add extra letters to point/vertex names.${imageModeInstructions}`;

  const userPrompt = `Extract all math problems from this PDF. Use this answer key for answers (do not solve):

${answerKeyText}

For each problem's "topics" field, use ONLY these exact tag names (copy them character-for-character): ${tagList}. No variations or synonyms allowed.

For each problem that has a diagram/figure/picture, set "hasDiagram": true, "diagramPage": <1-based page number>, and optionally "diagramRegion": { "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1 } for the diagram's bounding box. If no diagram, set "hasDiagram": false.
${useImageMode ? 'IMAGE MODE: Every problem MUST have "problemPage" (1-based) and "problemRegion" { "x", "y", "w", "h" }. Use x=0 and w=1. Use the problem NUMBER (1., 2., 3.) to determine boundaries — problem N starts at "N." and ends at the next number. Do NOT use spacing or gaps. If the problem has a diagram, the diagram MUST be fully included.' : ''}
For every problem, include "problemPage" (1-based page where the numbered problem begins), even when not using image mode.
Include "continuationPages" (1-based page numbers) for any additional pages containing the rest of the question or its diagram.

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
    const answer = answerMap[num] !== undefined ? String(answerMap[num]) : '';
    if (!answer.trim()) {
      errors.push({ number: num, message: `Answer key is missing problem ${num}` });
      continue;
    }
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
    const answerStored = answer.trim();
    const hasDiagram = Boolean(item.hasDiagram && item.diagramPage);
    const diagramPage = hasDiagram ? Math.max(1, parseInt(item.diagramPage, 10) || 1) : null;
    const diagramRegion = hasDiagram && item.diagramRegion && typeof item.diagramRegion === 'object'
      ? item.diagramRegion
      : null;
    const problemPage = item.problemPage != null ? Math.max(1, parseInt(item.problemPage, 10) || 1) : null;
    const continuationPagesRaw = Array.isArray(item.continuationPages) ? item.continuationPages : [];
    const continuationPages = continuationPagesRaw
      .map(page => Number(page))
      .filter(page => Number.isSafeInteger(page) && page > 0);
    const sourcePages = [...new Set([problemPage, diagramPage, ...continuationPages].filter(Boolean))].sort((a, b) => a - b);
    const problemRegion = problemPage && item.problemRegion && typeof item.problemRegion === 'object'
      ? item.problemRegion
      : null;
    results.push({ number: num, question, answer: answerStored, topics: [tag], source: `Problem ${num}`, hasDiagram, diagramPage, diagramRegion, problemPage, problemRegion, continuationPages, sourcePages });
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

export async function ensureTags(client, createdBy) {
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
 * Extract problems for image mode (no DB save). Returns processed list for review flow.
 */
export async function processPdfForImageMode(pdfBuffer, answerMap, allowedTagNames) {
  await assertPdfPageLimit(pdfBuffer);
  const { folderName, results: processedList, errors: batchErrors } = await processPdfDirectWithAI(pdfBuffer, answerMap, allowedTagNames, { useImageMode: true });
  const renderFn = await getRenderPdfPageToPng();
  if (renderFn && processedList.length > 0) await refineRegionsForImageMode(pdfBuffer, processedList, renderFn);
  return { folderName, processedList, errors: batchErrors };
}

/**
 * Extract text-layer PDFs locally for the teacher review flow. Scanned PDFs do
 * not silently fall back to Gemini; the caller can ask for explicit consent.
 */
export async function processPdfForTextReview(pdfBuffer, answerMap, allowedTagNames = []) {
  const loadingTask = getDocument({ data: new Uint8Array(pdfBuffer) });
  let pdf;
  try {
    pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      const error = new Error(`PDF contains ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES} pages`);
      error.status = 413;
      throw error;
    }
    const pages = [];
    let combined = '';
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const lineGroups = new Map();
      for (const item of textContent.items) {
        const value = (item.str || '').trim();
        if (!value) continue;
        const x = Number(item.transform?.[4]) || 0;
        const y = Number(item.transform?.[5]) || 0;
        const lineKey = Math.round(y / 2) * 2;
        if (!lineGroups.has(lineKey)) lineGroups.set(lineKey, []);
        lineGroups.get(lineKey).push({ x, value });
      }
      const pageText = [...lineGroups.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) => items.sort((a, b) => a.x - b.x).map(item => item.value).join(' '))
        .join('\n')
        .trim();
      if (/^\s*(?:answer\s*key|answers?\b|solutions?\b)/i.test(pageText.slice(0, 240))) {
        page.cleanup();
        break;
      }
      pages.push({ pageNumber, start: combined.length, text: pageText });
      combined += `${pageText}\n`;
      page.cleanup();
    }
    if (combined.replace(/\s/g, '').length < 80) {
      const error = new Error('This PDF has no readable text layer and appears to be scanned. Enable AI processing and consent to send it to Gemini, or use a text-based PDF.');
      error.status = 422;
      error.code = 'SCANNED_PDF_REQUIRES_CONSENT';
      throw error;
    }
    const problems = splitIntoProblems(combined);
    if (!problems.length) {
      const error = new Error('No numbered problems were found in the PDF text. Review the file or enable AI processing with consent.');
      error.status = 422;
      throw error;
    }
    const markerStarts = [...combined.matchAll(/(?:^|\n)\s*(?:problem\s+)?(\d+)\s*[\.\)\:]\s*/gim)];
    const defaultTag = allowedTagNames[0] || 'Arithmetic';
    const results = problems.map((problem, index) => {
      const answer = answerMap[problem.number];
      if (answer === undefined || !String(answer).trim()) {
        const error = new Error(`Answer key is missing problem ${problem.number}.`);
        error.status = 400;
        throw error;
      }
      const parsedAnswer = parseAndValidateAnswer(String(answer));
      if (parsedAnswer === null) {
        const error = new Error(`Answer key entry for problem ${problem.number} is invalid.`);
        error.status = 400;
        throw error;
      }
      const marker = markerStarts[index];
      if (!marker) {
        const error = new Error(`Could not find the source page marker for problem ${problem.number}.`);
        error.status = 422;
        throw error;
      }
      const markerIndex = marker.index;
      const nextMarkerIndex = markerStarts[index + 1]?.index ?? combined.length;
      const sourcePages = pages
        .filter(page => page.start < nextMarkerIndex && page.start + page.text.length >= markerIndex)
        .map(page => page.pageNumber);
      const pageNumber = sourcePages[0] || [...pages].reverse().find(page => page.start <= markerIndex)?.pageNumber || 1;
      return {
        number: problem.number,
        question: problem.raw,
        answer: String(answer).trim(),
        topics: [defaultTag],
        source: `Problem ${problem.number}`,
        problemPage: pageNumber,
        sourcePages: sourcePages.length ? sourcePages : [pageNumber],
        continuationPages: sourcePages.filter(page => page !== pageNumber),
        problemRegion: null,
      };
    });
    return { folderName: 'Imported from PDF', processedList: results, errors: [] };
  } finally {
    if (pdf) await pdf.destroy().catch(() => {});
    else await loadingTask.destroy().catch(() => {});
  }
}

/** Extract AI-assisted review candidates while retaining actual question text and page locations. */
export async function processPdfForReview(pdfBuffer, answerMap, allowedTagNames, { useAI, useImageMode = false, runVerification = false }) {
  let folderName;
  let processedList;
  let errors;
  if (!useAI) {
    ({ folderName, processedList, errors } = await processPdfForTextReview(pdfBuffer, answerMap, allowedTagNames));
  } else {
    await assertPdfPageLimit(pdfBuffer);
    ({ folderName, results: processedList, errors } = await processPdfDirectWithAI(
      pdfBuffer,
      answerMap,
      allowedTagNames,
      { useImageMode: false }
    ));
  }
  if (!processedList.length) {
    const error = new Error('No problems were extracted from this PDF.');
    error.status = 422;
    throw error;
  }
  if (errors?.length) {
    const firstError = errors[0]?.message || 'The extractor reported an incomplete result.';
    const error = new Error(`${firstError}. Nothing was saved; correct the answer key or retry the import.`);
    error.status = 422;
    throw error;
  }
  const numbers = processedList.map(problem => Number(problem.number));
  if (numbers.some(number => !Number.isSafeInteger(number) || number < 1) || new Set(numbers).size !== numbers.length) {
    const error = new Error('The extractor returned missing or duplicate question numbers. Nothing was saved; retry with a clearer PDF.');
    error.status = 422;
    throw error;
  }
  const extractedNumbers = new Set(numbers);
  const answerNumbers = Object.keys(answerMap).map(Number);
  const missingNumbers = answerNumbers.filter(number => !extractedNumbers.has(number));
  const unkeyedNumbers = numbers.filter(number => !Object.prototype.hasOwnProperty.call(answerMap, number));
  if (missingNumbers.length || unkeyedNumbers.length || answerNumbers.length !== numbers.length) {
    const problems = [
      missingNumbers.length ? `answer-key items not found: ${missingNumbers.join(', ')}` : '',
      unkeyedNumbers.length ? `questions without key entries: ${unkeyedNumbers.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    const error = new Error(`Could not confirm a complete one-to-one question and answer-key match${problems ? ` (${problems})` : ''}. Nothing was saved; correct the answer key or retry the import.`);
    error.status = 422;
    throw error;
  }
  for (const problem of processedList) {
    const sourcePages = Array.isArray(problem.sourcePages) ? problem.sourcePages : [];
    const allPages = [...new Set([problem.problemPage, problem.diagramPage, ...sourcePages].filter(Boolean))]
      .filter(page => Number.isSafeInteger(page) && page > 0)
      .sort((a, b) => a - b);
    problem.sourcePages = allPages.length ? allPages : [problem.problemPage];
  }
  if (useAI && runVerification && !useImageMode) {
    const corrections = await runVerificationPass(pdfBuffer, processedList, answerMap, allowedTagNames);
    for (const problem of processedList) {
      const correctedQuestion = corrections[problem.number];
      if (typeof correctedQuestion === 'string' && correctedQuestion.trim() && correctedQuestion.length <= 20000) {
        problem.question = correctedQuestion.trim();
      }
    }
  }
  const pageCountTask = getDocument({ data: new Uint8Array(pdfBuffer) });
  const pdf = await pageCountTask.promise;
  try {
    for (const problem of processedList) {
      if (!Number.isSafeInteger(problem.problemPage) || problem.problemPage < 1 || problem.problemPage > pdf.numPages) {
        const error = new Error(`Could not confirm the source page for problem ${problem.number}. Please use a text PDF or try another import mode.`);
        error.status = 422;
        throw error;
      }
      const invalidMappedPage = (problem.sourcePages || []).find(page => !Number.isSafeInteger(page) || page < 1 || page > pdf.numPages);
      if (invalidMappedPage) {
        const error = new Error(`Could not confirm page ${invalidMappedPage} for problem ${problem.number}. Nothing was saved.`);
        error.status = 422;
        throw error;
      }
      if (answerMap[problem.number] === undefined || !String(answerMap[problem.number]).trim()) {
        const error = new Error(`Answer key is missing problem ${problem.number}.`);
        error.status = 400;
        throw error;
      }
    }
  } finally {
    await pdf.destroy().catch(() => {});
  }
  if (useAI && useImageMode) {
    const renderFn = await getRenderPdfPageToPng();
    if (renderFn) await refineRegionsForImageMode(pdfBuffer, processedList, renderFn);
  }
  return { folderName, processedList, errors };
}

/** Inspect searchable PDF text and document metadata before any external processing. */
export async function inspectPdfForMathcountsMarkers(pdfBuffer) {
  const loadingTask = getDocument({ data: new Uint8Array(pdfBuffer) });
  let pdf;
  try {
    pdf = await loadingTask.promise;
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = metadata?.info || {};
    const xmp = metadata?.metadata?.getAll?.() || {};
    const searchableParts = [
      ...Object.entries(info).map(([key, value]) => `${key} ${String(value ?? '')}`),
      ...Object.entries(xmp).map(([key, value]) => `${key} ${String(value ?? '')}`),
      pdfBuffer.toString('latin1'),
    ];
    let meaningfulTextCharacters = 0;
    let imageBackedPageCount = 0;
    let largestImageAreaFraction = 0;
    let scanLikePageCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      const pageText = text.items.map(item => item.str || '').join(' ');
      const pageTextCharacters = pageText.replace(/\s/g, '').length;
      meaningfulTextCharacters += pageTextCharacters;
      searchableParts.push(pageText);
      const operatorList = await page.getOperatorList();
      const view = page.view || [0, 0, 0, 0];
      const pageArea = Math.abs((view[2] - view[0]) * (view[3] - view[1]));
      const imageAreaFraction = pageArea > 0 ? estimatePaintedImageAreaFraction(operatorList, pageArea) : 0;
      largestImageAreaFraction = Math.max(largestImageAreaFraction, imageAreaFraction);
      if (imageAreaFraction >= 0.6) imageBackedPageCount++;
      // Any visible raster content may contain text that isn't in the text
      // layer. Require exact-file approval independently of hidden/selectable
      // text so cropped scans cannot bypass the OCR rights gate.
      if (imageAreaFraction > 0) scanLikePageCount++;
      page.cleanup();
    }
    const imageBackedPageFraction = pdf.numPages ? imageBackedPageCount / pdf.numPages : 0;
    // A single scan-like page is enough to require the exact-file approval.
    // Hidden text on the other pages must not dilute an image-backed page.
    const scanLike = imageBackedPageCount > 0 || scanLikePageCount > 0 ||
      (!meaningfulTextCharacters && largestImageAreaFraction > 0);
    return {
      detectedMathcounts: /math\s*counts|mathcounts\.org/i.test(searchableParts.join('\n')),
      hasMeaningfulTextLayer: meaningfulTextCharacters >= 80,
      meaningfulTextCharacters,
      imageBackedPageCount,
      scanLikePageCount,
      imageBackedPageFraction,
      largestImageAreaFraction,
      scanLike,
    };
  } finally {
    if (pdf) await pdf.destroy().catch(() => {});
    else await loadingTask.destroy().catch(() => {});
  }
}

function multiplyPdfTransforms(current, next) {
  const [a, b, c, d, e, f] = current;
  const [g, h, i, j, k, l] = next;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

function estimatePaintedImageAreaFraction(operatorList, pageArea) {
  const imageOps = new Set([
    OPS.paintImageXObject,
    OPS.paintJpegXObject,
    OPS.paintInlineImageXObject,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageMaskXObject,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat,
  ].filter(Number.isInteger));
  const stack = [];
  let transform = [1, 0, 0, 1, 0, 0];
  let totalArea = 0;
  for (let index = 0; index < operatorList.fnArray.length; index++) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] || [];
    if (operation === OPS.save) {
      stack.push(transform);
    } else if (operation === OPS.restore) {
      transform = stack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (operation === OPS.transform && Array.isArray(args) && args.length >= 6) {
      transform = multiplyPdfTransforms(transform, args.slice(0, 6).map(Number));
    } else if (imageOps.has(operation)) {
      const [a, b, c, d] = transform;
      const drawnArea = Math.abs(a * d - b * c);
      if (Number.isFinite(drawnArea)) totalArea += drawnArea;
    }
  }
  return Math.min(1, totalArea / pageArea);
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
  await assertPdfPageLimit(pdfBuffer);
  const useImageMode = opts.useImageMode === true;
  const runVerification = opts.runVerification !== false;
  const errors = [];
  const answerMap = parseAnswerKey(answerKeyText);

  await cleanupStaleUnreferencedUploads(pool);
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
              const uploadRes = await insertImageUpload(client, {
                data: base64,
                filename: `problem-${processed.number}.png`,
                contentType: 'image/png',
                createdBy,
              });
              imageUrl = '/uploads/db/' + uploadRes.rows[0].id;
            } catch (renderErr) {
              if (renderErr.status === 413) throw renderErr;
              console.warn('Problem image extraction failed for problem', processed.number, renderErr.message);
            }
          } else if (!useImageMode && processed.hasDiagram && processed.diagramPage) {
            try {
              const pngBuffer = await renderFn(pdfBuffer, processed.diagramPage, processed.diagramRegion);
              const base64 = pngBuffer.toString('base64');
              const uploadRes = await insertImageUpload(client, {
                data: base64,
                filename: `problem-${processed.number}-diagram.png`,
                contentType: 'image/png',
                createdBy,
              });
              imageUrl = '/uploads/db/' + uploadRes.rows[0].id;
            } catch (renderErr) {
              if (renderErr.status === 413) throw renderErr;
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
