/**
 * Test script for PDF import. Run with: node test-pdf-import.js
 * Requires: backend running (npm run dev), GEMINI_API_KEY in .env
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_URL = process.env.API_URL || 'https://test-platform-api-tji7.onrender.com';

async function createTestPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const { height } = page.getSize();

  const text = `2024 Mock Sprint Round

1. What is 2 + 3?
2. What is 4 times 5?
3. What is the square root of 16?

Answer key:
1. 5
2. 20
3. 4`;

  page.drawText(text, {
    x: 50,
    y: height - 100,
    size: 12,
    font,
  });

  return await doc.save();
}

async function testImport() {
  console.log('Creating test PDF...');
  const pdfBytes = await createTestPdf();
  const pdfPath = path.join(__dirname, 'test-import.pdf');
  fs.writeFileSync(pdfPath, pdfBytes);
  console.log('Saved to', pdfPath);

  console.log('Logging in as admin...');
  const loginRes = await fetch(`${API_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  const { token } = await loginRes.json();

  const formData = new FormData();
  formData.set('pdf', new Blob([pdfBytes], { type: 'application/pdf' }), 'test.pdf');
  formData.append('answerKey', '1. 5\n2. 20\n3. 4');
  formData.append('useAI', 'true');

  console.log('Importing PDF (AI mode)...');
  const start = Date.now();
  const importRes = await fetch(`${API_URL}/api/import-pdf`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (!importRes.ok) {
    const err = await importRes.text();
    throw new Error(`Import failed (${importRes.status}): ${err}`);
  }

  const data = await importRes.json();
  console.log(`\nDone in ${elapsed}s`);
  console.log('Result:', JSON.stringify(data, null, 2));
  fs.unlinkSync(pdfPath);
}

testImport().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
