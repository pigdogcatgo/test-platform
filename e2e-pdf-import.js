/**
 * E2E test: PDF import via browser.
 * Run from project root:
 *   npx playwright install chromium   (first time only)
 *   PDF_PATH=./path/to/your.pdf SITE_URL=http://localhost:5173 node e2e-pdf-import.js
 *
 * For deployed site, use your frontend URL for SITE_URL.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_URL = process.env.SITE_URL || 'http://localhost:5173';
const PDF_PATH = process.env.PDF_PATH;
const DEFAULT_ANSWER_KEY = `1. 17
2. 96pi
3. 38
4. 15
5. 0.4
6. 42
7. 19
8. 24
9. 2/5
10. 20
11. 258
12. 15
13. sqrt22
14. (sqrt545)/2
15. 3/7
16. 84
17. 120
18. -1
19. 5
20. (32sqrt22)/11
21. 24
22. 33/5
23. 33
24. 14
25. 315
26. 84
27. 25
28. 16385/32768
29. (15sqrt15)/26
30. 12`;
const ANSWER_KEY = process.env.ANSWER_KEY || DEFAULT_ANSWER_KEY;
const USERNAME = process.env.USERNAME || 'admin';
const PASSWORD = process.env.PASSWORD || 'admin123';

if (!PDF_PATH) {
  console.error('Usage: PDF_PATH=/path/to/file.pdf [SITE_URL=http://localhost:5173] node e2e-pdf-import.js');
  process.exit(1);
}

const absPdfPath = path.isAbsolute(PDF_PATH) ? PDF_PATH : path.resolve(process.cwd(), PDF_PATH);

async function run() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.setDefaultTimeout(360000); // 6 min for import

  try {
    console.log('Navigating to', SITE_URL);
    await page.goto(SITE_URL, { waitUntil: 'networkidle' });

    // Login
    console.log('Logging in as', USERNAME, '...');
    await page.getByPlaceholder(/Username/).fill(USERNAME);
    await page.getByPlaceholder(/Password/).fill(PASSWORD);
    await page.getByRole('button', { name: /Log in/i }).click();

    // Wait for navigation away from login
    await page.waitForTimeout(3000);
    const stillOnLogin = await page.locator('input[placeholder*="Username"]').isVisible();
    if (stillOnLogin) {
      await page.screenshot({ path: 'e2e-login-failed.png' });
      throw new Error('Still on login page - check credentials (default: admin/admin123)');
    }
    // Wait for Admin Portal (admin view) - scroll down to Import section
    await page.waitForSelector('text=Admin Portal', { timeout: 5000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await page.waitForSelector('text=Import from PDF', { timeout: 5000 });

    // Enable Use AI (checkbox next to "Use AI (LaTeX...")
    await page.getByLabel(/Use AI/).check();

    // Set file
    const fileInput = page.locator('#pdf-import-input');
    await fileInput.setInputFiles(absPdfPath);

    // Fill answer key if provided
    if (ANSWER_KEY) {
      const answerKeyTextarea = page.locator('textarea[placeholder*="1. 101"]');
      await answerKeyTextarea.fill(ANSWER_KEY);
      console.log('Answer key filled');
    }

    // Click Import
    console.log('Starting import (may take several minutes)...');
    await page.click('button:has-text("Import")');

    // Wait for result - either error or success (up to 6 min)
    await page.waitForSelector('[class*="bg-red-50"], [class*="bg-green-50"]', {
      timeout: 360000,
    });

    const resultEl = page.locator('[class*="bg-red-50"], [class*="bg-green-50"]').first();
    const resultText = await resultEl.textContent();

    console.log('\n--- Result ---');
    console.log(resultText);

    // Check for timeout
    if (resultText?.toLowerCase().includes('timeout')) {
      console.error('\n❌ TIMEOUT - Import exceeded 5 min (Render limit)');
      process.exit(1);
    }

    // Check for error
    const hasError = resultText && await page.locator('[class*="bg-red-50"]').isVisible();
    if (hasError) {
      console.error('\n❌ Import failed');
      process.exit(1);
    }

    // Success - expand first folder and count problems
    console.log('\n✓ Import completed. Checking imported problems...');
    const expandBtn = page.locator('button').filter({ hasText: '▶' }).first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(1500);
    }
    const problemRows = await page.locator('table tbody tr').count();
    console.log(`Problems visible in table: ${problemRows}`);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
