import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { isIP } from 'net';
import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { PDFDocument, PDFName } from 'pdf-lib';
import pool, { initDatabase, seedDatabase } from './db.js';
import { cleanupStaleUnreferencedUploads, deleteUnreferencedImageUploads, insertImageUpload } from './storageLimits.js';
import { parseAndValidateAnswer, parseAnswerToNumber, compareAnswers } from './answerUtils.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const frontendDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/dist');
if (process.env.TRUST_PROXY != null && process.env.TRUST_PROXY.trim() !== '') {
  const proxyHops = Number(process.env.TRUST_PROXY);
  if (!Number.isSafeInteger(proxyHops) || proxyHops < 0 || proxyHops > 10) {
    throw new Error('TRUST_PROXY must be an integer hop count from 0 to 10');
  }
  app.set('trust proxy', proxyHops);
}

function fixedWindowRateLimit({ limit, windowMs, keyForRequest }) {
  const buckets = new Map();
  const maxBuckets = 10000;
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.startedAt >= windowMs) buckets.delete(key);
    }
    const key = keyForRequest(req);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxBuckets) {
        res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ error: 'Rate limit temporarily unavailable; retry later' });
      }
      bucket = { startedAt: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000))));
      return res.status(429).json({ error: 'Too many requests; try again later' });
    }
    next();
  };
}

const clientIpHeader = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
const ipForRequest = (req) => {
  if (clientIpHeader === 'cf-connecting-ip') {
    const forwardedIp = req.get('cf-connecting-ip')?.trim();
    if (forwardedIp && isIP(forwardedIp)) return forwardedIp;
    return 'invalid-cloudflare-connecting-ip';
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
};
const signupLimiter = fixedWindowRateLimit({ limit: 5, windowMs: 15 * 60 * 1000, keyForRequest: (req) => ipForRequest(req) });
const loginLimiter = fixedWindowRateLimit({ limit: 20, windowMs: 15 * 60 * 1000, keyForRequest: (req) => ipForRequest(req) });
const PDF_IMPORT_GLOBAL_LIMIT = 12;
const PDF_IMPORT_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
async function pdfImportGlobalLimiter(req, res, next) {
  try {
    const result = await pool.query(
      `WITH observed AS (SELECT clock_timestamp() AS at)
       INSERT INTO api_rate_limit_buckets AS bucket (bucket_key, window_started_at, request_count)
       SELECT 'pdf-import-global', observed.at, 1 FROM observed
       ON CONFLICT (bucket_key) DO UPDATE SET
         window_started_at = CASE
           WHEN bucket.window_started_at <= EXCLUDED.window_started_at - INTERVAL '1 hour'
           THEN EXCLUDED.window_started_at ELSE bucket.window_started_at END,
         request_count = CASE
           WHEN bucket.window_started_at <= EXCLUDED.window_started_at - INTERVAL '1 hour'
           THEN 1 ELSE LEAST(bucket.request_count + 1, $1 + 1) END
       RETURNING request_count, window_started_at`,
      [PDF_IMPORT_GLOBAL_LIMIT]
    );
    if (result.rowCount !== 1) throw new Error('Global PDF request counter did not return its shared bucket');
    const bucket = result.rows[0];
    if (Number(bucket.request_count) > PDF_IMPORT_GLOBAL_LIMIT) {
      const retryMs = new Date(bucket.window_started_at).getTime() + PDF_IMPORT_GLOBAL_WINDOW_MS - Date.now();
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryMs / 1000))));
      return res.status(429).json({ error: 'Global PDF import limit reached; try again later' });
    }
    next();
  } catch (error) {
    console.error('Global PDF request counter failed:', error);
    return res.status(503).json({ error: 'PDF import is temporarily unavailable' });
  }
}
const pdfImportLimiter = fixedWindowRateLimit({
  limit: 3,
  windowMs: 60 * 60 * 1000,
  keyForRequest: (req) => `user:${req.user.id}`,
});

let activePdfRequests = 0;
const MAX_CONCURRENT_PDF_REQUESTS = 2;
function pdfImportConcurrencyLimit(req, res, next) {
  if (activePdfRequests >= MAX_CONCURRENT_PDF_REQUESTS) {
    res.setHeader('Retry-After', '30');
    return res.status(429).json({ error: 'PDF import is busy; try again shortly' });
  }
  activePdfRequests++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activePdfRequests = Math.max(0, activePdfRequests - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

function validateJwtSecret() {
  const secret = process.env.JWT_SECRET;
  const normalizedSecret = secret?.trim().toLowerCase() || '';
  const isPlaceholder = ['secret', 'changeme', 'change-me', 'your-secret', 'your_jwt_secret', 'dev-secret', 'replace-with', 'placeholder', 'example']
    .some((marker) => normalizedSecret === marker || normalizedSecret.includes(marker));
  if (!secret || secret.length < 32 || isPlaceholder) {
    throw new Error('JWT_SECRET must be a non-placeholder secret of at least 32 characters. Generate one with: openssl rand -base64 48');
  }
}

// Uploads directory: use UPLOADS_DIR for persistent storage (e.g. Render disk at /var/data/uploads)
const uploadsDir = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer: memory storage so we can save to DB (free persistence on Render)
const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only images (JPEG, PNG, GIF, WebP) are allowed'));
  }
});

const uploadPdf = multer({
  storage: memoryStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB for PDFs
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

// Middleware
const defaultDevOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const configuredOrigins = (process.env.CORS_ORIGINS || (process.env.NODE_ENV === 'production' ? '' : defaultDevOrigins.join(',')))
  .split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || configuredOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  }
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json());

function hasValidImageSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) return false;
  switch (mimeType) {
    case 'image/jpeg':
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/png':
      return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6));
    case 'image/webp':
      return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    default:
      return false;
  }
}

function hasValidPdfSignature(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-';
}

function requireValidPdfUpload(req, res, next) {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'No PDF file provided' });
  }
  if (!hasValidPdfSignature(req.file.buffer)) {
    return res.status(400).json({ error: 'PDF content does not match its declared file type' });
  }
  next();
}

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Access denied' });
  
  jwt.verify(token, process.env.JWT_SECRET, async (err, claims) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    try {
      const result = await pool.query(
        'SELECT id, username, role, teacher_id FROM users WHERE id = $1',
        [claims.id]
      );
      const currentUser = result.rows[0];
      if (!currentUser) return res.status(401).json({ error: 'Account no longer exists' });
      req.user = currentUser;
      next();
    } catch (queryError) {
      console.error('Authentication account lookup failed:', queryError.message);
      res.status(503).json({ error: 'Authentication service unavailable' });
    }
  });
};

function requireContentManager(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

async function attachFolderAndTags(problem, db = pool) {
  const [folderRow, tagRows] = await Promise.all([
    problem.folder_id ? db.query('SELECT name FROM folders WHERE id = $1', [problem.folder_id]) : Promise.resolve({ rows: [] }),
    db.query('SELECT tag_id FROM problem_tags WHERE problem_id = $1', [problem.id])
  ]);
  const tagIds = tagRows.rows.map(r => r.tag_id);
  const tagNames = tagIds.length ? (await db.query('SELECT id, name FROM tags WHERE id = ANY($1)', [tagIds])).rows : [];
  const tagMap = Object.fromEntries(tagNames.map(t => [t.id, t.name]));
  return {
    ...problem,
    folder_name: folderRow.rows[0]?.name || null,
    tag_ids: tagIds,
    tag_names: tagIds.map(tid => tagMap[tid]).filter(Boolean)
  };
}

// ELO calculation
function calculateELO(playerRating, opponentRating, outcome, kFactor = 32) {
  const expectedScore = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
  return Math.round(playerRating + kFactor * (outcome - expectedScore));
}

// Dynamic K: higher when less data (more volatility), lower when more data (less volatility)
function getKFactor(baseK, attempts) {
  return baseK / Math.sqrt(1 + (attempts || 0));
}

// Routes

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (_error) {
    res.status(503).json({ status: 'unavailable' });
  }
});

// Teacher signup
app.post('/api/signup', signupLimiter, async (req, res) => {
  try {
    if (process.env.ENABLE_TEACHER_SIGNUP === 'false') {
      return res.status(403).json({ error: 'Teacher self-signup is disabled' });
    }
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const normalizedUsername = username.trim();
    if (normalizedUsername.length < 3 || normalizedUsername.length > 50) {
      return res.status(400).json({ error: 'Username must be between 3 and 50 characters' });
    }
    if (Array.from(password).length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters' });
    }
    if (Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Password must be at most 72 UTF-8 bytes' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, elo',
      [normalizedUsername, passwordHash, 'teacher']
    );
    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        elo: user.elo
      }
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Username already taken' });
    }
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        elo: user.elo
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user (with subject-specific ELOs for students)
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, role, elo, teacher_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    if (user.role === 'student') {
      const tagElos = await pool.query(
        `SELECT t.name, ste.elo FROM student_tag_elo ste
         JOIN tags t ON t.id = ste.tag_id
         WHERE ste.user_id = $1 ORDER BY t.name`,
        [req.user.id]
      );
      user.tag_elos = tagElos.rows;
      const mathcounts = await pool.query(
        `SELECT t.test_type, ta.score FROM test_attempts ta
         JOIN tests t ON t.id = ta.test_id WHERE ta.student_id = $1`,
        [req.user.id]
      );
      let sprint = 0, target = 0;
      for (const r of mathcounts.rows) {
        if (r.test_type === 'target') target += r.score;
        else sprint += r.score;
      }
      user.cumulative_score = sprint + 2 * target;
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Folders: read = public+own; write = admin all, teacher own only
function folderReadWhere(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'teacher') return { sql: '(created_by IS NULL OR created_by = $1)', params: [user.id] };
  return { sql: '1=0', params: [] };
}
function folderWriteWhere(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'teacher') return { sql: 'created_by = $1', params: [user.id] };
  return { sql: '1=0', params: [] };
}

// Folders (admin: all CRUD; teacher: read public + own, write own only)
app.get('/api/folders', authenticateToken, async (req, res) => {
  try {
    const { sql, params } = folderReadWhere(req.user);
    const result = await pool.query(`SELECT * FROM folders WHERE ${sql} ORDER BY name`, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/folders', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') return res.status(403).json({ error: 'Access denied' });
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Folder name is required' });
  }
  try {
    const createdBy = req.user.role === 'admin' ? null : req.user.id;
    const result = await pool.query(
      'INSERT INTO folders (name, created_by) VALUES ($1, $2) RETURNING *',
      [name.trim(), createdBy]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.put('/api/folders/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') return res.status(403).json({ error: 'Access denied' });
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Folder name is required' });
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid folder id' });
  try {
    const { sql, params } = folderWriteWhere(req.user);
    const sqlBump = params.length ? sql.replace(/\$1/g, '$3') : sql;
    const result = await pool.query(
      `UPDATE folders SET name = $1 WHERE id = $2 AND ${sqlBump} RETURNING *`,
      [name.trim(), id, ...params]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Folder not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.delete('/api/folders/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') return res.status(403).json({ error: 'Access denied' });
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid folder id' });
  try {
    const { sql, params } = folderWriteWhere(req.user);
    const sqlBump = params.length ? sql.replace(/\$1/g, '$2') : sql;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const authorized = await client.query(`SELECT id FROM folders WHERE id = $1 AND ${sqlBump} FOR UPDATE`, [id, ...params]);
      if (authorized.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Folder not found' });
      }
      if (req.user.role === 'admin') {
        await client.query('UPDATE problems SET folder_id = NULL WHERE folder_id = $1', [id]);
      } else {
        await client.query('UPDATE problems SET folder_id = NULL WHERE folder_id = $1 AND created_by = $2', [id, req.user.id]);
        const remaining = await client.query('SELECT 1 FROM problems WHERE folder_id = $1 LIMIT 1', [id]);
        if (remaining.rowCount > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Folder is still used by problems you cannot modify' });
        }
      }
      await client.query(`DELETE FROM folders WHERE id = $1 AND ${sqlBump}`, [id, ...params]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Import session storage for image-mode review flow (TTL 20 min)
const importSessions = new Map();
const IMPORT_SESSION_TTL = 20 * 60 * 1000;
const MAX_IMPORT_SESSIONS = 5;
const MAX_GEMINI_RETRIES_PER_SESSION = 3;
let importStartReservations = 0;
const PDF_STORAGE_GLOBAL_LIMIT = 200 * 1024 * 1024;
const PDF_STORAGE_TEACHER_LIMIT = 50 * 1024 * 1024;

function validatePdfRights(req, res) {
  const sourceTitle = typeof req.body.sourceTitle === 'string' ? req.body.sourceTitle.trim() : '';
  const sourceUrl = typeof req.body.sourceUrl === 'string' ? req.body.sourceUrl.trim() : '';
  const licenseBasis = typeof req.body.licenseBasis === 'string' ? req.body.licenseBasis.trim() : '';
  const licenseName = typeof req.body.licenseName === 'string' ? req.body.licenseName.trim() : '';
  const permissionReference = typeof req.body.permissionReference === 'string' ? req.body.permissionReference.trim() : '';
  if (req.body.rightsConfirmed !== 'true' || req.body.studentSafePagesConfirmed !== 'true') {
    res.status(400).json({ error: 'Confirm you may upload, store, and share this PDF with assigned students, and that approved question pages contain no answers or solutions.' });
    return null;
  }
  if (!sourceTitle || sourceTitle.length > 200 || !['teacher_created', 'open_license', 'written_permission'].includes(licenseBasis)) {
    res.status(400).json({ error: 'Provide a source title and a valid rights basis (teacher-created, open-license, or written permission).' });
    return null;
  }
  if (licenseBasis === 'open_license' && !licenseName) {
    res.status(400).json({ error: 'Enter the name of the open license that permits this use.' });
    return null;
  }
  if (licenseName.length > 200) {
    res.status(400).json({ error: 'License name must be under 200 characters.' });
    return null;
  }
  if (sourceUrl && (!/^https?:\/\//i.test(sourceUrl) || sourceUrl.length > 2000)) {
    res.status(400).json({ error: 'Source URL must be a valid HTTP or HTTPS URL under 2000 characters.' });
    return null;
  }
  if (licenseBasis === 'written_permission' && !permissionReference) {
    res.status(400).json({ error: 'Add a reference for the written permission.' });
    return null;
  }
  if (permissionReference.length > 2000) {
    res.status(400).json({ error: 'Permission reference must be under 2000 characters.' });
    return null;
  }
  const mathcountsMaterial = /mathcounts/i.test(`${sourceTitle} ${sourceUrl} ${req.file?.originalname || ''}`);
  if (mathcountsMaterial && (licenseBasis !== 'written_permission' || !permissionReference)) {
    res.status(403).json({ error: 'MATHCOUNTS material requires documented written permission before it can be uploaded for student viewing.' });
    return null;
  }
  const useAI = req.body.useAI === 'true';
  if (useAI && (req.body.allowGeminiProcessing !== 'true' || req.body.aiRightsConfirmed !== 'true')) {
    res.status(400).json({ error: 'Gemini processing is optional. To use it, explicitly consent and confirm that the PDF rights allow external AI processing.' });
    return null;
  }
  return { sourceTitle, sourceUrl: sourceUrl || null, licenseBasis, licenseName: licenseName || null, permissionReference: permissionReference || null, rightsConfirmed: true, geminiAllowed: useAI };
}

async function enforceMathcountsPermissionGate(req, rights) {
  const declaredSource = `${rights.sourceTitle} ${rights.sourceUrl || ''} ${req.file?.originalname || ''}`;
  const declaredMathcounts = /math\s*counts|mathcounts\.org/i.test(declaredSource);
  const { inspectPdfForMathcountsMarkers } = await import('./pdfImport.js');
  const inspection = await inspectPdfForMathcountsMarkers(req.file.buffer);
  const digest = createHash('sha256').update(req.file.buffer).digest('hex');
  if (inspection.scanLike || !inspection.hasMeaningfulTextLayer) {
    const approvedScans = (process.env.PDF_APPROVED_SCANNED_SHA256 || '')
      .split(',').map(value => value.trim().toLowerCase()).filter(value => /^[a-f0-9]{64}$/.test(value));
    if (!approvedScans.includes(digest)) {
      const error = new Error(`This PDF contains embedded images or has too little searchable text. Ask the platform administrator to add its exact SHA-256 (${digest}) to the Render PDF_APPROVED_SCANNED_SHA256 environment variable, then retry. If OCR uses Gemini, teacher consent and source rights are also required.`);
      error.status = 403;
      throw error;
    }
  }
  const detectedMathcounts = inspection.detectedMathcounts;
  if (!declaredMathcounts && !detectedMathcounts) return;
  if (rights.licenseBasis !== 'written_permission' || !rights.permissionReference) {
    const error = new Error('This PDF appears to contain MATHCOUNTS material. A server-approved written permission is required before import.');
    error.status = 403;
    throw error;
  }
  const approvedDigests = (process.env.MATHCOUNTS_APPROVED_PDF_SHA256 || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(value => /^[a-f0-9]{64}$/.test(value));
  if (!approvedDigests.includes(digest)) {
    const error = new Error('MATHCOUNTS PDFs are blocked unless this exact file has been approved by the platform administrator.');
    error.status = 403;
    throw error;
  }
}

async function assertPdfStorageQuota(client, teacherId, addingBytes) {
  const globalResult = await client.query(
    'SELECT COALESCE(SUM(original_size + student_size), 0)::bigint AS used FROM source_documents'
  );
  if (Number(globalResult.rows[0].used) + addingBytes > PDF_STORAGE_GLOBAL_LIMIT) {
    const error = new Error('Private PDF storage is temporarily full. Contact the platform administrator before importing another PDF.');
    error.status = 413;
    throw error;
  }
  const teacherResult = await client.query(
    'SELECT COALESCE(SUM(original_size + student_size), 0)::bigint AS used FROM source_documents WHERE created_by = $1',
    [teacherId]
  );
  if (Number(teacherResult.rows[0].used) + addingBytes > PDF_STORAGE_TEACHER_LIMIT) {
    const error = new Error('Your private PDF storage limit is full. Contact the platform administrator before importing another PDF.');
    error.status = 413;
    throw error;
  }
}

async function makeStudentPdf(pdfBuffer, sourcePages) {
  const source = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const pageCount = source.getPageCount();
  const selected = [...new Set(sourcePages)].sort((a, b) => a - b);
  if (!selected.length || selected.some(page => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
    const error = new Error('The reviewed questions do not have valid PDF page locations.');
    error.status = 400;
    throw error;
  }
  const safeDocument = await PDFDocument.create();
  const copiedPages = await safeDocument.copyPages(source, selected.map(page => page - 1));
  for (const page of copiedPages) {
    // Do not carry source links, annotations, or additional actions into the
    // student copy. The in-app viewer displays page content only.
    page.node.delete(PDFName.of('Annots'));
    page.node.delete(PDFName.of('AA'));
    safeDocument.addPage(page);
  }
  for (const key of ['OpenAction', 'AA', 'Names', 'AcroForm']) {
    safeDocument.catalog.delete(PDFName.of(key));
  }
  const studentPageBySourcePage = Object.fromEntries(selected.map((sourcePage, index) => [sourcePage, index + 1]));
  const safeBuffer = Buffer.from(await safeDocument.save({ useObjectStreams: true }));
  return { safeBuffer, studentPageBySourcePage, studentPageCount: selected.length, originalPageCount: pageCount };
}

async function getPdfPageCount(pdfBuffer) {
  const document = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  return document.getPageCount();
}

async function persistReviewedPdfImport(importId, session) {
  const { pdfBuffer, processedList, folderName, tagMap, allowedTagNames, defaultTag, createdBy, rights, useAI } = session;
  const safeBuffer = session.studentPdfPreview;
  const studentPageBySourcePage = session.studentPageBySourcePage;
  const studentPageCount = session.studentPageCount;
  const originalPageCount = session.sourcePageCount;
  if (!Buffer.isBuffer(safeBuffer) || !studentPageBySourcePage || !studentPageCount) {
    const error = new Error('The student PDF preview expired. Restart the import and review it again.');
    error.status = 409;
    throw error;
  }
  const sourcePages = [...new Set(processedList.flatMap(problem => problem.sourcePages || [problem.problemPage]))].sort((a, b) => a - b);
  const originalSize = pdfBuffer.length;
  const studentSize = safeBuffer.length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertPdfStorageQuota(client, createdBy, originalSize + studentSize);
    const sourceDocument = await client.query(
      `INSERT INTO source_documents
         (created_by, source_title, source_url, license_basis, license_name, permission_reference,
          rights_confirmed, gemini_allowed, original_data, student_data, original_sha256,
          original_size, student_size, original_pages, student_pages)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [createdBy, rights.sourceTitle, rights.sourceUrl, rights.licenseBasis, rights.licenseName, rights.permissionReference,
        rights.rightsConfirmed, useAI, pdfBuffer, safeBuffer, createHash('sha256').update(pdfBuffer).digest('hex'),
        originalSize, studentSize, originalPageCount, studentPageCount]
    );
    const sourceDocumentId = sourceDocument.rows[0].id;
    let folderRow = await client.query('SELECT id FROM folders WHERE name = $1 AND (created_by IS NOT DISTINCT FROM $2)', [folderName, createdBy]);
    if (folderRow.rows.length === 0) {
      folderRow = await client.query('INSERT INTO folders (name, created_by) VALUES ($1, $2) RETURNING id', [folderName, createdBy]);
    }
    const folderId = folderRow.rows[0].id;
    let imported = 0;
    for (const problem of processedList) {
      const tagName = (problem.topics?.[0] || defaultTag).trim();
      const validTag = allowedTagNames.includes(tagName) ? tagName : defaultTag;
      const imageUrl = problem.confirmedImageUrl || null;
      const sourceProblemPages = [...new Set(problem.sourcePages || [problem.problemPage])].sort((a, b) => a - b);
      const studentProblemPages = sourceProblemPages.map(page => studentPageBySourcePage[page]).filter(Number.isSafeInteger);
      if (!studentProblemPages.length || studentProblemPages.length !== sourceProblemPages.length) {
        const error = new Error(`The sanitized PDF is missing one or more reviewed pages for problem ${problem.number}.`);
        error.status = 400;
        throw error;
      }
      const ins = await client.query(
        `INSERT INTO problems
           (question, answer, topic, image_url, source, folder_id, created_by, pdf_document_id,
            source_page, student_pdf_page, source_pages, student_pdf_pages)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [problem.question, String(problem.answer), validTag, imageUrl, problem.source, folderId, createdBy, sourceDocumentId,
          problem.problemPage, studentPageBySourcePage[problem.problemPage], sourceProblemPages, studentProblemPages]
      );
      const tagId = tagMap[validTag];
      if (tagId) await client.query('INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ins.rows[0].id, tagId]);
      imported++;
    }
    await client.query('COMMIT');
    importSessions.delete(importId);
    return { success: true, done: true, imported, folderId, folderName, sourceDocumentId, errors: session.errors };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
async function cleanupImportSessionImages(session) {
  const imageUrls = session?.processedList?.map((problem) => problem.confirmedImageUrl).filter(Boolean) || [];
  if (!imageUrls.length) return;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await deleteUnreferencedImageUploads(client, imageUrls, session.createdBy);
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.warn('Could not clean up abandoned PDF review images:', error.message);
  } finally {
    client?.release();
  }
}
function pruneImportSessions() {
  const now = Date.now();
  for (const [id, s] of importSessions) {
    if (!s.busy && now - (s.lastActivityAt || s.createdAt) > IMPORT_SESSION_TTL) {
      importSessions.delete(id);
      void cleanupImportSessionImages(s);
    }
  }
}
setInterval(pruneImportSessions, 60000);

// Import problems from PDF (admin + teacher)
app.get('/api/import-pdf', (_req, res) => {
  res.status(405).json({ error: 'Use POST to import a PDF', ok: true });
});
app.post('/api/import-pdf', authenticateToken, requireContentManager, pdfImportConcurrencyLimit, pdfImportLimiter, uploadPdf.single('pdf'), requireValidPdfUpload, pdfImportGlobalLimiter, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied' });
  }
  return res.status(409).json({ error: 'PDF imports must use the reviewed upload flow at /api/import-pdf/start.' });
});

app.get('/api/import-pdf/:importId/preview', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).send('Teacher access required');
  const session = importSessions.get(req.params.importId);
  if (!session) return res.status(404).send('Import session expired or not found');
  if (session.ownerUserId !== req.user.id) return res.status(403).send('This import session belongs to another teacher');
  if (!session.awaitingStudentPdfApproval || !Buffer.isBuffer(session.studentPdfPreview)) {
    return res.status(409).send('Review all questions before previewing the student PDF');
  }
  session.lastActivityAt = Date.now();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="student-pdf-preview.pdf"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Length', String(session.studentPdfPreview.length));
  return res.status(200).send(session.studentPdfPreview);
});

app.post('/api/import-pdf/start', authenticateToken, requireContentManager, pdfImportConcurrencyLimit, pdfImportLimiter, uploadPdf.single('pdf'), requireValidPdfUpload, pdfImportGlobalLimiter, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required for private student PDF imports.' });
  }
  const rights = validatePdfRights(req, res);
  if (!rights) return;
  const answerKey = typeof req.body.answerKey === 'string' ? req.body.answerKey.trim() : '';
  if (!answerKey.trim()) {
    return res.status(400).json({ error: 'Answer key is required for PDF import.' });
  }
  const useAI = rights.geminiAllowed;
  const useImageMode = req.body.useImageMode === 'true';
  const runVerification = req.body.runVerification === 'true';
  const createdBy = req.user.id;
  pruneImportSessions();
  if (importSessions.size + importStartReservations >= MAX_IMPORT_SESSIONS) {
    return res.status(429).json({ error: 'Too many active PDF review sessions; try again later' });
  }
  importStartReservations++;
  let importId;
  try {
    const { processPdfForReview, renderProblemScreenshot, parseAnswerKey, ensureTags } = await import('./pdfImport.js');
    await enforceMathcountsPermissionGate(req, rights);
    const answerMap = parseAnswerKey(answerKey);
    if (Object.keys(answerMap).length === 0) return res.status(400).json({ error: 'Enter a numbered answer key before importing.' });
    const sourcePageCount = await getPdfPageCount(req.file.buffer);
    const SYSTEM_TAG_NAMES = ['Algebra', 'Arithmetic', 'Counting', 'Geometry', 'Number Theory', 'Probability'];
    const client = await pool.connect();
    const tagMap = await ensureTags(client, createdBy);
    client.release();
    const { folderName, processedList, errors: batchErrors } = await processPdfForReview(req.file.buffer, answerMap, SYSTEM_TAG_NAMES, { useAI, useImageMode, runVerification });
    if (processedList.length === 0) {
      return res.status(400).json({ error: 'No problems extracted from PDF' });
    }
    const invalidPage = processedList.find(problem => !Number.isSafeInteger(problem.problemPage) || problem.problemPage < 1);
    if (invalidPage) {
      return res.status(422).json({ error: `Could not map problem ${invalidPage.number} to a source PDF page.` });
    }
    importId = randomBytes(24).toString('hex');
    importSessions.set(importId, {
      pdfBuffer: req.file.buffer,
      ownerUserId: req.user.id,
      processedList,
      folderName,
      errors: batchErrors,
      tagMap,
      allowedTagNames: SYSTEM_TAG_NAMES,
      defaultTag: 'Arithmetic',
      createdBy,
      rights,
      useAI,
      useImageMode,
      sourcePageCount,
      currentIndex: 0,
      retryCount: 0,
      retryAttemptsTotal: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    const screenshot = await renderProblemScreenshot(req.file.buffer, processedList[0]);
    res.json({
      importId,
      problemIndex: 0,
      problemNumber: processedList[0].number,
      total: processedList.length,
      folderName,
      question: processedList[0].question,
      answer: processedList[0].answer,
      sourcePage: processedList[0].problemPage,
      rights: { sourceTitle: rights.sourceTitle, licenseBasis: rights.licenseBasis },
      screenshot: screenshot ? `data:image/png;base64,${screenshot}` : null,
      errors: batchErrors,
      reviewVersion: 0,
    });
  } catch (error) {
    if (importId) importSessions.delete(importId);
    console.error('PDF import start error:', error);
    res.status(error.status || 400).json({ error: error.message || 'Import failed' });
  } finally {
    importStartReservations--;
  }
});

app.post('/api/import-pdf/confirm', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { importId, accepted, direction, finalPdfApproved } = req.body;
  if (!importId) return res.status(400).json({ error: 'importId is required' });
  const session = importSessions.get(importId);
  if (!session) {
    return res.status(404).json({ error: 'Import session expired or not found' });
  }
  if (session.ownerUserId !== req.user.id) {
    return res.status(403).json({ error: 'This import session belongs to another user' });
  }
  if (session.busy) return res.status(409).json({ error: 'This import session is already processing a confirmation' });
  if (Object.prototype.hasOwnProperty.call(req.body, 'finalPdfApproved')) {
    if (typeof finalPdfApproved !== 'boolean') return res.status(400).json({ error: 'finalPdfApproved must be a boolean' });
    if (!session.awaitingStudentPdfApproval) return res.status(409).json({ error: 'Review every question before approving the student PDF.' });
    session.busy = true;
    session.lastActivityAt = Date.now();
    try {
      if (!finalPdfApproved) {
        importSessions.delete(importId);
        await cleanupImportSessionImages(session);
        return res.json({ cancelled: true, message: 'PDF import cancelled; no source document or problems were saved.' });
      }
      const result = await persistReviewedPdfImport(importId, session);
      return res.json(result);
    } catch (error) {
      console.error('Final PDF approval error:', error);
      return res.status(error.status || 500).json({ error: error.message || 'Could not save the reviewed PDF import.' });
    } finally {
      session.busy = false;
    }
  }
  if (typeof accepted !== 'boolean') return res.status(400).json({ error: 'accepted (boolean) required for problem review' });
  if (session.awaitingStudentPdfApproval) return res.status(409).json({ error: 'Approve or cancel the final student PDF preview.' });
  const dir = direction === 'up' || direction === 'down' ? direction : null;
  session.busy = true;
  session.lastActivityAt = Date.now();
  const { pdfBuffer, processedList, folderName, tagMap, allowedTagNames, defaultTag, createdBy, rights, useAI, sourcePageCount } = session;
  const idx = session.currentIndex;
  const processed = processedList[idx];
  if (!processed) {
    session.busy = false;
    return res.status(400).json({ error: 'Invalid problem index' });
  }

  try {
    const { renderProblemScreenshot, retryRegionForProblem } = await import('./pdfImport.js');

    if (accepted) {
      if (req.body.question !== undefined) {
        if (typeof req.body.question !== 'string' || !req.body.question.trim() || req.body.question.length > 20000) {
          return res.status(400).json({ error: 'Corrected question text must contain 1 to 20000 characters.' });
        }
        processed.question = req.body.question.trim();
      }
      if (req.body.answer !== undefined) {
        if (typeof req.body.answer !== 'string' || !req.body.answer.trim() || parseAndValidateAnswer(req.body.answer.trim()) === null) {
          return res.status(400).json({ error: 'Corrected answer is invalid. Enter the answer in the supported plain-text format.' });
        }
        processed.answer = req.body.answer.trim();
      }
      if (!processed.question || processed.question.length > 20000 || !String(processed.answer || '').trim() || parseAndValidateAnswer(String(processed.answer)) === null) {
        return res.status(400).json({ error: 'Review and correct the question and answer before accepting this item.' });
      }
      if (req.body.sourcePage !== undefined) {
        const correctedPage = Number(req.body.sourcePage);
        if (!Number.isSafeInteger(correctedPage) || correctedPage < 1 || correctedPage > sourcePageCount) {
          return res.status(400).json({ error: `Source page must be a whole number between 1 and ${sourcePageCount}.` });
        }
        if (correctedPage !== processed.problemPage) {
          processed.problemPage = correctedPage;
          processed.sourcePages = [...new Set([correctedPage, processed.diagramPage, ...(processed.continuationPages || [])].filter(Boolean))].sort((a, b) => a - b);
          processed.problemRegion = null;
          session.reviewVersion = (session.reviewVersion || 0) + 1;
          const screenshot = await renderProblemScreenshot(pdfBuffer, processed);
          return res.json({
            importId,
            problemIndex: idx,
            problemNumber: processed.number,
            total: processedList.length,
            question: processed.question,
            answer: processed.answer,
            sourcePage: processed.problemPage,
            screenshot: screenshot ? `data:image/png;base64,${screenshot}` : null,
            pageChanged: true,
            reviewVersion: session.reviewVersion,
          });
        }
      }
      if (!Number.isSafeInteger(processed.problemPage) || processed.problemPage < 1) {
        return res.status(400).json({ error: 'This problem has no valid PDF page mapping and cannot be accepted.' });
      }
      session.retryCount = 0;
      // Review screenshots are session-only unless image mode is selected. In
      // that case, keep the accepted question crop for regular tests; its image
      // endpoint independently checks that it belongs to an assigned test.
      if (session.useImageMode) {
        const base64 = await renderProblemScreenshot(pdfBuffer, processed);
        if (base64) {
          await cleanupStaleUnreferencedUploads(pool);
          const uploadClient = await pool.connect();
          let uploadRes;
          try {
            await uploadClient.query('BEGIN');
            uploadRes = await insertImageUpload(uploadClient, {
              data: base64,
              filename: `problem-${processed.number}.png`,
              contentType: 'image/png',
              createdBy,
            });
            await uploadClient.query('COMMIT');
          } catch (error) {
            await uploadClient.query('ROLLBACK').catch(() => {});
            throw error;
          } finally {
            uploadClient.release();
          }
          processed.confirmedImageUrl = '/uploads/db/' + uploadRes.rows[0].id;
        }
      }
      session.currentIndex = idx + 1;
      if (session.currentIndex >= processedList.length) {
        const sourcePages = [...new Set(processedList.flatMap(problem => problem.sourcePages || [problem.problemPage]))].sort((a, b) => a - b);
        const { safeBuffer, studentPageBySourcePage, studentPageCount, originalPageCount } = await makeStudentPdf(pdfBuffer, sourcePages);
        session.studentPdfPreview = safeBuffer;
        session.studentPageBySourcePage = studentPageBySourcePage;
        session.studentPageCount = studentPageCount;
        session.originalPageCount = originalPageCount;
        session.awaitingStudentPdfApproval = true;
        session.lastActivityAt = Date.now();
        return res.json({
          importId,
          awaitingStudentPdfApproval: true,
          sourceTitle: rights.sourceTitle,
          studentPageCount,
          reviewedQuestionCount: processedList.length,
          message: 'Review the exact student-facing PDF. No problems or source document have been saved yet.',
        });
      }
      const nextProcessed = processedList[session.currentIndex];
      const screenshot = await renderProblemScreenshot(pdfBuffer, nextProcessed);
      return res.json({
        importId,
        problemIndex: session.currentIndex,
        problemNumber: nextProcessed.number,
        total: processedList.length,
        question: nextProcessed.question,
        answer: nextProcessed.answer,
        sourcePage: nextProcessed.problemPage,
        screenshot: screenshot ? `data:image/png;base64,${screenshot}` : null,
        reviewVersion: 0,
      });
    } else {
      if (!useAI) {
        return res.status(409).json({ error: 'AI retries were not enabled for this import. Edit the question or answer, then approve it only if the displayed source page is correct.' });
      }
      if ((session.retryAttemptsTotal || 0) >= MAX_GEMINI_RETRIES_PER_SESSION) {
        return res.status(429).json({ error: `Retry limit reached for this PDF review session (${MAX_GEMINI_RETRIES_PER_SESSION})` });
      }
      session.retryCount = (session.retryCount || 0) + 1;
      session.retryAttemptsTotal = (session.retryAttemptsTotal || 0) + 1;
      const ok = await retryRegionForProblem(pdfBuffer, processed, session.retryCount, dir);
      const screenshot = await renderProblemScreenshot(pdfBuffer, processed);
      session.reviewVersion = (session.reviewVersion || 0) + 1;
      return res.json({
        importId,
        problemIndex: idx,
        problemNumber: processed.number,
        total: processedList.length,
        question: processed.question,
        answer: processed.answer,
        sourcePage: processed.problemPage,
        screenshot: screenshot ? `data:image/png;base64,${screenshot}` : null,
        retried: ok,
        reviewVersion: session.reviewVersion,
      });
    }
  } catch (error) {
    if (session.currentIndex >= processedList.length) {
      importSessions.delete(importId);
      void cleanupImportSessionImages(session);
    }
    console.error('PDF import confirm error:', error);
    res.status(error.status || 400).json({ error: error.message || 'Confirm failed' });
  } finally {
    session.busy = false;
  }
});

// Tags: read = public+own; write (delete) = admin all, teacher own only
function tagReadWhere(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'teacher') return { sql: '(created_by IS NULL OR created_by = $1)', params: [user.id] };
  return { sql: '1=0', params: [] };
}
function tagWriteWhere(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'teacher') return { sql: 'created_by = $1', params: [user.id] };
  return { sql: '1=0', params: [] };
}

app.get('/api/tags', authenticateToken, async (req, res) => {
  try {
    const { sql, params } = tagReadWhere(req.user);
    const result = await pool.query(`SELECT * FROM tags WHERE ${sql} ORDER BY name`, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/tags', authenticateToken, async (req, res) => {
  return res.status(403).json({ error: 'Tag creation is disabled. Only the six system tags (Algebra, Arithmetic, Counting, Geometry, Number Theory, Probability) are available.' });
});

app.delete('/api/tags/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') return res.status(403).json({ error: 'Access denied' });
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid tag id' });
  try {
    const tagRow = await pool.query('SELECT name, is_system FROM tags WHERE id = $1', [id]);
    if (tagRow.rows.length === 0) return res.status(404).json({ error: 'Tag not found' });
    const systemNames = ['Algebra', 'Arithmetic', 'Counting', 'Geometry', 'Number Theory', 'Probability'];
    const isSystem = tagRow.rows[0].is_system === true || systemNames.includes(tagRow.rows[0].name);
    if (isSystem) {
      return res.status(403).json({ error: 'System tags cannot be deleted.' });
    }
    const { sql, params } = tagWriteWhere(req.user);
    const sqlBump = params.length ? sql.replace(/\$1/g, '$2') : sql;
    const del = await pool.query(`DELETE FROM tags WHERE id = $1 AND ${sqlBump} RETURNING id`, [id, ...params]);
    if (del.rowCount === 0) return res.status(404).json({ error: 'Tag not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Problems: read = admin all, teacher public+own; write = admin all, teacher own only
function problemReadWhere(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'teacher') return { sql: '(p.created_by IS NULL OR p.created_by = $1)', params: [user.id] };
  return { sql: '1=0', params: [] };
}
function problemWriteWhere(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'teacher') return { sql: 'created_by = $1', params: [user.id] };
  return { sql: '1=0', params: [] };
}

function validationError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function validateProblemFolder(client, user, rawFolderId) {
  if (rawFolderId == null) return null;
  const folderId = typeof rawFolderId === 'number' ? rawFolderId : /^\d+$/.test(rawFolderId) ? Number(rawFolderId) : NaN;
  if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 2147483647) {
    throw validationError(400, 'folder_id must be a positive integer or null');
  }
  const { sql, params } = folderReadWhere(user);
  const scopedSql = params.length ? sql.replace(/\$1/g, '$2') : sql;
  const result = await client.query(`SELECT id FROM folders WHERE id = $1 AND ${scopedSql}`, [folderId, ...params]);
  if (result.rowCount === 0) throw validationError(404, 'Folder not found or unavailable');
  return folderId;
}

async function validateProblemTags(client, user, rawTagIds) {
  if (rawTagIds == null) return [];
  if (!Array.isArray(rawTagIds) || rawTagIds.length > 100) {
    throw validationError(400, 'tag_ids must be an array containing at most 100 tag ids');
  }
  const tagIds = rawTagIds.map((id) => typeof id === 'number' ? id : (typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : NaN));
  if (!tagIds.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647) || new Set(tagIds).size !== tagIds.length) {
    throw validationError(400, 'tag_ids must contain unique positive integer ids');
  }
  if (tagIds.length === 0) return [];
  const { sql, params } = tagReadWhere(user);
  const scopedSql = params.length ? sql.replace(/\$1/g, '$2') : sql;
  const result = await client.query(`SELECT id FROM tags WHERE id = ANY($1::int[]) AND ${scopedSql}`, [tagIds, ...params]);
  if (result.rowCount !== tagIds.length) throw validationError(400, 'One or more tags are unavailable');
  return tagIds;
}

// Get all problems (with folder and tags)
app.get('/api/problems', authenticateToken, async (req, res) => {
  try {
    const { sql, params } = problemReadWhere(req.user);
    const result = await pool.query(`
        SELECT p.*, f.name as folder_name
        FROM problems p
        LEFT JOIN folders f ON p.folder_id = f.id
        WHERE ${sql}
        ORDER BY COALESCE(f.name, 'zzz'), p.id
      `, params);
    const tagResult = await pool.query('SELECT problem_id, tag_id FROM problem_tags');
    const tagsByProblem = {};
    for (const row of tagResult.rows) {
      if (!tagsByProblem[row.problem_id]) tagsByProblem[row.problem_id] = [];
      tagsByProblem[row.problem_id].push(row.tag_id);
    }
    const tagNames = await pool.query('SELECT id, name FROM tags');
    const tagMap = Object.fromEntries(tagNames.rows.map(r => [r.id, r.name]));
    const problems = result.rows.map(p => ({
      ...p,
      tag_ids: tagsByProblem[p.id] || [],
      tag_names: (tagsByProblem[p.id] || []).map(tid => tagMap[tid]).filter(Boolean)
    }));
    res.json(problems);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload image (admin + teacher)
app.post('/api/upload', authenticateToken, requireContentManager, upload.single('image'), async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'No image file provided' });
  }
  if (!hasValidImageSignature(req.file.buffer, req.file.mimetype)) {
    return res.status(400).json({ error: 'Image content does not match its declared file type' });
  }
  const dataBase64 = req.file.buffer.toString('base64');
  const contentType = req.file.mimetype || 'image/png';
  const filename = req.file.originalname || `problem-${Date.now()}.png`;
  const createdBy = req.user.role === 'admin' ? null : req.user.id;
  let client;
  try {
    await cleanupStaleUnreferencedUploads(pool);
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await insertImageUpload(client, { data: dataBase64, filename, contentType, createdBy });
    await client.query('COMMIT');
    const id = result.rows[0].id;
    res.json({ url: '/uploads/db/' + id });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Upload save error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to save image' });
  } finally {
    client?.release();
  }
});

// Serve DB-stored image
app.get('/api/uploads/db/:id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send('Bad request');
  try {
    const result = await pool.query('SELECT data, content_type, created_by FROM uploads WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).send('Not found');
    const row = result.rows[0];
    if (req.user.role === 'admin') {
      // Admin can see all
    } else if (req.user.role === 'teacher') {
      if (row.created_by != null && row.created_by !== req.user.id) return res.status(403).send('Forbidden');
    } else if (req.user.role === 'student') {
      const studentRow = await pool.query('SELECT teacher_id FROM users WHERE id = $1', [req.user.id]);
      const teacherId = studentRow.rows[0]?.teacher_id;
      if (row.created_by != null && row.created_by !== teacherId) return res.status(403).send('Forbidden');
      const assignedProblemImage = await pool.query(
        `SELECT 1
         FROM problems p
         JOIN tests t ON p.id = ANY(t.problem_ids)
         LEFT JOIN test_sessions ts ON ts.test_id = t.id AND ts.student_id = $2
         LEFT JOIN test_attempts ta ON ta.test_id = t.id AND ta.student_id = $2
         WHERE p.image_url = $1 AND t.created_by = $3
           AND ((ts.submitted_at IS NULL AND ts.expires_at + INTERVAL '30 seconds' >= CURRENT_TIMESTAMP)
             OR ta.id IS NOT NULL)
         LIMIT 1`,
        ['/uploads/db/' + id, req.user.id, teacherId]
      );
      if (!assignedProblemImage.rowCount) return res.status(403).send('This image is not part of one of your tests');
    } else {
      return res.status(403).send('Forbidden');
    }
    const buf = Buffer.from(row.data, 'base64');
    if (!hasValidImageSignature(buf, row.content_type)) return res.status(415).send('Unsupported media type');
    res.setHeader('Content-Type', row.content_type);
    res.send(buf);
  } catch (err) {
    console.error('Upload serve error:', err);
    res.status(500).send('Server error');
  }
});

// Serve file on disk (legacy / local)
app.get('/api/uploads/:filename', authenticateToken, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename || filename !== req.params.filename || filename.includes('..')) {
    return res.status(400).send('Bad request');
  }
  const filepath = path.join(uploadsDir, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(filepath);
});

// Create problem (admin + teacher)
app.post('/api/problems', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { question, answer, image_url: imageUrl, source, folder_id: folderId, tag_ids: tagIds } = req.body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }
  const answerVal = parseAndValidateAnswer(answer);
  if (answerVal === null) {
    return res.status(400).json({ error: 'A valid answer is required (e.g. 42, 3/4, √2, or "Saturday", "(-1,-3)" for strings/ordered pairs)' });
  }
  const answerStored = typeof answer === 'string' && answer.trim() ? answer.trim() : (typeof answerVal === 'number' ? String(answerVal) : answerVal);
  const createdBy = req.user.role === 'admin' ? null : req.user.id;
  const sourceStr = typeof source === 'string' ? source.trim() || null : null;
  let problem;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const fid = await validateProblemFolder(client, req.user, folderId);
    const validTagIds = await validateProblemTags(client, req.user, tagIds);
    const result = await client.query(
      'INSERT INTO problems (question, answer, topic, image_url, source, folder_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [question.trim(), answerStored, '', imageUrl || null, sourceStr, fid, createdBy]
    );
    problem = result.rows[0];
    for (const tid of validTagIds) {
      await client.query('INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2)', [problem.id, tid]);
    }
    const withMeta = await attachFolderAndTags(problem, client);
    await client.query('COMMIT');
    res.json(withMeta);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Create problem error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Server error' });
  } finally {
    client?.release();
  }
});

// Bulk move and bulk delete
app.put('/api/problems/bulk-move', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { ids, folder_id: folderId } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const validIds = ids.map(id => parseInt(id, 10)).filter(n => Number.isInteger(n) && n > 0);
  if (validIds.length === 0) {
    return res.status(400).json({ error: 'No valid problem ids' });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const fid = await validateProblemFolder(client, req.user, folderId);
    const { sql, params } = problemWriteWhere(req.user);
    const problemCond = sql.replace(/p\./g, '').replace(/\$1/g, params.length ? '$3' : '$1');
    const result = await client.query(
      `UPDATE problems SET folder_id = $1 WHERE id = ANY($2) AND ${problemCond} RETURNING id`,
      [fid, validIds, ...params]
    );
    await client.query('COMMIT');
    res.json({ updated: result.rowCount });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Bulk move error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Server error' });
  } finally {
    client?.release();
  }
});

app.delete('/api/problems/bulk', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied' });
  }
  const ids = req.body?.ids ?? req.query?.ids;
  const idArray = Array.isArray(ids) ? ids : (typeof ids === 'string' ? ids.split(',').map(s => s.trim()) : []);
  if (idArray.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const validIds = idArray.map(id => parseInt(id, 10)).filter(n => Number.isInteger(n) && n > 0);
  if (validIds.length === 0) {
    return res.status(400).json({ error: 'No valid problem ids' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { sql, params } = problemWriteWhere(req.user);
    const sqlBump = params.length ? sql.replace(/\$1/g, '$2') : sql;
    const del = await client.query(
      `DELETE FROM problems WHERE id = ANY($1) AND ${sqlBump} RETURNING id, image_url`,
      [validIds, ...params]
    );
    for (const { id } of del.rows) {
      if (req.user.role === 'teacher') {
        await client.query(
          'UPDATE tests SET problem_ids = array_remove(problem_ids, $1) WHERE $1 = ANY(problem_ids) AND created_by = $2',
          [id, req.user.id]
        );
      } else {
        await client.query('UPDATE tests SET problem_ids = array_remove(problem_ids, $1) WHERE $1 = ANY(problem_ids)', [id]);
      }
    }
    await deleteUnreferencedImageUploads(client, del.rows.map((row) => row.image_url), req.user.role === 'teacher' ? req.user.id : null);
    await client.query('COMMIT');
    res.json({ deleted: del.rowCount });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Bulk delete error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  } finally {
    client.release();
  }
});

// Update problem (admin all; teacher own only)
app.put('/api/problems/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { question, answer, image_url: imageUrl, source, folder_id: folderId, tag_ids: tagIds } = req.body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }
  const answerVal = parseAndValidateAnswer(answer);
  if (answerVal === null) {
    return res.status(400).json({ error: 'A valid answer is required (e.g. 42, 3/4, √2, or "Saturday", "(-1,-3)" for strings/ordered pairs)' });
  }
  const answerStored = typeof answer === 'string' && answer.trim() ? answer.trim() : (typeof answerVal === 'number' ? String(answerVal) : answerVal);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const fid = await validateProblemFolder(client, req.user, folderId);
    const validTagIds = await validateProblemTags(client, req.user, tagIds);
    const { sql, params } = problemWriteWhere(req.user);
    const problemCond = sql.replace(/p\./g, '').replace(/\$1/g, params.length ? '$8' : '$1');
    const sourceStr = typeof source === 'string' ? source.trim() || null : null;
    const result = await client.query(
      `UPDATE problems SET question = $1, answer = $2, topic = $3, image_url = $4, source = $5, folder_id = $6 WHERE id = $7 AND ${problemCond} RETURNING *`,
      [question.trim(), answerStored, '', imageUrl || null, sourceStr, fid, req.params.id, ...params]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Problem not found' });
    }
    const problem = result.rows[0];
    await client.query('DELETE FROM problem_tags WHERE problem_id = $1', [problem.id]);
    for (const tid of validTagIds) {
      await client.query('INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2)', [problem.id, tid]);
    }
    const withMeta = await attachFolderAndTags(problem, client);
    await client.query('COMMIT');
    res.json(withMeta);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Update problem error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Server error' });
  } finally {
    client?.release();
  }
});

// Delete problem (admin + teacher, own/public only)
app.delete('/api/problems/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied' });
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'Invalid problem id' });
  }
  const { sql, params } = problemWriteWhere(req.user);
  const sqlBump = params.length ? sql.replace(/\$1/g, '$2') : sql;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const del = await client.query(
      `DELETE FROM problems WHERE id = $1 AND ${sqlBump} RETURNING id, image_url`,
      [id, ...params]
    );
    if (del.rowCount > 0) {
      if (req.user.role === 'teacher') {
        await client.query(
          'UPDATE tests SET problem_ids = array_remove(problem_ids, $1) WHERE $1 = ANY(problem_ids) AND created_by = $2',
          [id, req.user.id]
        );
      } else {
        await client.query('UPDATE tests SET problem_ids = array_remove(problem_ids, $1) WHERE $1 = ANY(problem_ids)', [id]);
      }
      await deleteUnreferencedImageUploads(client, del.rows.map((row) => row.image_url), req.user.role === 'teacher' ? req.user.id : null);
    }
    await client.query('COMMIT');
    if (del.rowCount === 0) {
      return res.status(404).json({ error: 'Problem not found' });
    }
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Delete problem error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  } finally {
    client.release();
  }
});

// Get all tests (students see only their teacher's tests; teachers see only their own)
app.get('/api/tests', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'student') {
      const userRow = await pool.query('SELECT teacher_id FROM users WHERE id = $1', [req.user.id]);
      const teacherId = userRow.rows[0]?.teacher_id;
      if (teacherId == null) {
        return res.json([]);
      }
      const result = await pool.query(
        `SELECT t.*,
                (ts.expires_at IS NOT NULL AND ts.expires_at + INTERVAL '30 seconds' < CURRENT_TIMESTAMP) AS session_expired
         FROM tests t
         LEFT JOIN test_sessions ts ON ts.test_id = t.id AND ts.student_id = $2
         WHERE t.created_by = $1
         ORDER BY t.created_at DESC`,
        [teacherId, req.user.id]
      );
      return res.json(result.rows);
    }
    if (req.user.role === 'teacher') {
      const result = await pool.query(
        'SELECT * FROM tests WHERE created_by = $1 ORDER BY created_at DESC',
        [req.user.id]
      );
      return res.json(result.rows);
    }
    const result = await pool.query('SELECT * FROM tests ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create test (teacher only)
app.post('/api/tests', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  
  try {
    const { name, problemIds, dueDate, timeLimit, testType } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) {
      return res.status(400).json({ error: 'Test name is required and must be at most 200 characters' });
    }
    const dateMatch = typeof dueDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate) : null;
    if (dateMatch) {
      const year = Number(dateMatch[1]);
      const month = Number(dateMatch[2]);
      const day = Number(dateMatch[3]);
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysPerMonth[month - 1]) {
        return res.status(400).json({ error: 'dueDate must be a real date in YYYY-MM-DD format' });
      }
    } else {
      return res.status(400).json({ error: 'dueDate must be a real date in YYYY-MM-DD format' });
    }
    const timeLimitMinutes = typeof timeLimit === 'number' ? timeLimit : Number(timeLimit);
    if (!Number.isInteger(timeLimitMinutes) || timeLimitMinutes < 1 || timeLimitMinutes > 240) {
      return res.status(400).json({ error: 'timeLimit must be an integer between 1 and 240 minutes' });
    }
    if (!Array.isArray(problemIds) || problemIds.length === 0 || problemIds.length > 200) {
      return res.status(400).json({ error: 'problemIds must contain between 1 and 200 problem ids' });
    }
    const type = testType === 'target' ? 'target' : 'sprint';
    const expectedProblemCount = type === 'target' ? 8 : 30;
    if (problemIds.length !== expectedProblemCount) {
      return res.status(400).json({ error: `${type === 'target' ? 'Target' : 'Sprint'} tests require exactly ${expectedProblemCount} problems` });
    }
    if (!problemIds.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647) || new Set(problemIds).size !== problemIds.length) {
      return res.status(400).json({ error: 'problemIds must be unique positive integer ids' });
    }
    const accessible = await pool.query(
      `SELECT id, created_by, pdf_document_id, source_page, student_pdf_page, source_pages, student_pdf_pages
       FROM problems WHERE id = ANY($1::int[]) AND (created_by IS NULL OR created_by = $2)`,
      [problemIds, req.user.id]
    );
    if (accessible.rowCount !== problemIds.length) {
      return res.status(400).json({ error: 'Every problem must be public or owned by you' });
    }
    const problemById = new Map(accessible.rows.map(problem => [problem.id, problem]));
    const problemDocumentIds = [...new Set(accessible.rows.map(problem => problem.pdf_document_id).filter(Boolean))];
    const hasSourceDocumentChoice = Object.prototype.hasOwnProperty.call(req.body, 'sourceDocumentId');
    const rawDocumentChoice = req.body.sourceDocumentId;
    const suppliedDocumentId = rawDocumentChoice == null || rawDocumentChoice === ''
      ? null
      : Number(rawDocumentChoice);
    if (suppliedDocumentId != null && (!Number.isSafeInteger(suppliedDocumentId) || suppliedDocumentId < 1)) {
      return res.status(400).json({ error: 'sourceDocumentId must be a positive integer.' });
    }
    // A null value means the teacher chose a regular test without a viewer.
    // If older clients omit the field, infer only when every selected problem
    // belongs to the same source PDF; mixed/legacy tests keep working as before.
    const canInferSinglePdf = problemDocumentIds.length === 1 && accessible.rows.every(problem => problem.pdf_document_id === problemDocumentIds[0]);
    const sourceDocumentId = hasSourceDocumentChoice
      ? suppliedDocumentId
      : (canInferSinglePdf ? problemDocumentIds[0] : null);
    if (sourceDocumentId != null) {
      if (problemDocumentIds.length !== 1 || problemDocumentIds[0] !== sourceDocumentId || accessible.rows.some(problem => problem.pdf_document_id !== sourceDocumentId)) {
        return res.status(400).json({ error: 'All questions in a PDF-based test must come from the same PDF source.' });
      }
      const sourceDoc = await pool.query(
        'SELECT id FROM source_documents WHERE id = $1 AND created_by = $2 AND rights_confirmed = true',
        [sourceDocumentId, req.user.id]
      );
      if (!sourceDoc.rowCount) return res.status(403).json({ error: 'The PDF source is unavailable or has not been rights-approved.' });
      if (accessible.rows.some(problem => !problem.source_page || !problem.student_pdf_page || !problem.source_pages?.length || !problem.student_pdf_pages?.length)) {
        return res.status(400).json({ error: 'Every question must have a reviewed source page before it can be assigned with a PDF.' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO tests (name, problem_ids, due_date, time_limit, created_by, test_type, source_document_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [name.trim(), problemIds, dueDate, timeLimitMinutes, req.user.id, type, sourceDocumentId]
      );
      if (sourceDocumentId != null) {
        for (const problemId of problemIds) {
          const problem = problemById.get(problemId);
          await client.query(
            `INSERT INTO test_problem_pdf_locations (test_id, problem_id, source_page, pdf_page, source_pages, pdf_pages)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [result.rows[0].id, problemId, problem.source_page, problem.student_pdf_page, problem.source_pages, problem.student_pdf_pages]
          );
        }
      }
      await client.query('COMMIT');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update test (teacher only) - solutions_link, answers_released
app.put('/api/tests/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher access required' });
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid test id' });
  const { solutions_link: solutionsLink, answers_released: answersReleased } = req.body;
  try {
    const updates = [];
    const params = [];
    let i = 1;
    if (typeof solutionsLink === 'string') {
      updates.push(`solutions_link = $${i++}`);
      params.push(solutionsLink.trim() || null);
    }
    if (typeof answersReleased === 'boolean') {
      updates.push(`answers_released = $${i++}`);
      params.push(answersReleased);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });
    params.push(id, req.user.id);
    const result = await pool.query(
      `UPDATE tests SET ${updates.join(', ')} WHERE id = $${i++} AND created_by = $${i} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Test not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Get student's test attempts
app.get('/api/attempts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM test_attempts WHERE student_id = $1 ORDER BY completed_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get attempt details with answers/correct answers (when test complete: due passed or all submitted)
app.get('/api/attempts/:id/details', authenticateToken, async (req, res) => {
  try {
    const attemptId = parseInt(req.params.id, 10);
    if (Number.isNaN(attemptId)) return res.status(400).json({ error: 'Invalid attempt id' });
    const attemptRows = await pool.query(
      'SELECT ta.*, t.due_date, t.problem_ids, t.created_by, t.solutions_link, t.answers_released FROM test_attempts ta JOIN tests t ON t.id = ta.test_id WHERE ta.id = $1',
      [attemptId]
    );
    const attempt = attemptRows.rows[0];
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    const isOwner = attempt.student_id === req.user.id;
    const isTeacher = req.user.role === 'teacher' && attempt.created_by === req.user.id;
    if (!isOwner && !isTeacher) return res.status(403).json({ error: 'Access denied' });
    const duePassed = new Date(attempt.due_date) <= new Date();
    const studentCount = (await pool.query(
      'SELECT COUNT(*)::int FROM users WHERE role = $1 AND teacher_id = $2',
      ['student', attempt.created_by]
    )).rows[0].count;
    const submittedCount = (await pool.query(
      'SELECT COUNT(*)::int FROM test_attempts WHERE test_id = $1',
      [attempt.test_id]
    )).rows[0].count;
    const allSubmitted = studentCount > 0 && submittedCount >= studentCount;
    const answersReleased = attempt.answers_released === true;
    const showAnswers = (duePassed || allSubmitted) && (answersReleased || isTeacher);
    const answers = typeof attempt.answers === 'string' ? JSON.parse(attempt.answers) : (attempt.answers || {});
    const results = typeof attempt.results === 'string' ? JSON.parse(attempt.results) : (attempt.results || {});
    const problemIds = attempt.problem_ids || [];
    let problems = [];
    if (showAnswers && problemIds.length > 0) {
      const probsRows = await pool.query('SELECT id, question, answer, image_url FROM problems WHERE id = ANY($1)', [problemIds]);
      const probMap = Object.fromEntries(probsRows.rows.map(p => [p.id, p]));
      for (const pid of problemIds) {
        const p = probMap[pid];
        if (!p) continue;
        problems.push({
          problem_id: pid,
          question: p.question,
          image_url: p.image_url,
          student_answer: answers[pid] ?? '',
          correct: results[pid] === true,
          correct_answer: showAnswers ? p.answer : undefined
        });
      }
    }
    res.json({
      attempt: {
        id: attempt.id,
        test_id: attempt.test_id,
        score: attempt.score,
        total: attempt.total,
        elo_before: attempt.elo_before,
        elo_after: attempt.elo_after,
        completed_at: attempt.completed_at,
        student_id: attempt.student_id
      },
      showAnswers,
      solutionsLink: attempt.solutions_link || null,
      problems
    });
  } catch (error) {
    console.error('Attempt details error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get problems for a test (students need this to load test content; verify access via teacher)
app.get('/api/tests/:id/problems', authenticateToken, async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    if (Number.isNaN(testId)) return res.status(400).json({ error: 'Invalid test id' });
    const testResult = await pool.query('SELECT * FROM tests WHERE id = $1', [testId]);
    const test = testResult.rows[0];
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const problemIds = test.problem_ids || [];
    if (req.user.role === 'student') {
      const studentRow = await pool.query('SELECT teacher_id FROM users WHERE id = $1', [req.user.id]);
      const teacherId = studentRow.rows[0]?.teacher_id;
      if (teacherId == null || teacherId !== test.created_by) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const sessionResult = await pool.query(
        `SELECT submitted_at,
                expires_at + INTERVAL '30 seconds' < CURRENT_TIMESTAMP AS expired
         FROM test_sessions WHERE test_id = $1 AND student_id = $2`,
        [testId, req.user.id]
      );
      const session = sessionResult.rows[0];
      if (!session) return res.status(409).json({ error: 'Start this test before loading its questions' });
      if (session.submitted_at) return res.status(400).json({ error: 'Test already submitted' });
      if (session.expired) {
        return res.status(410).json({ error: 'The test time limit has passed' });
      }
    } else if (req.user.role === 'teacher' && test.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    } else if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (problemIds.length === 0) return res.json([]);
    const visibility = req.user.role === 'admin' ? '' : ' AND (p.created_by IS NULL OR p.created_by = $3)';
    const result = await pool.query(
      `SELECT p.id, p.question, p.topic, p.image_url, p.source, p.folder_id,
              p.pdf_document_id, p.source_page, p.student_pdf_page,
              f.name AS folder_name,
              locations.source_page AS test_source_page,
              locations.pdf_page AS test_pdf_page,
              locations.source_pages AS test_source_pages,
              locations.pdf_pages AS test_pdf_pages
       FROM problems p LEFT JOIN folders f ON p.folder_id = f.id
       LEFT JOIN test_problem_pdf_locations locations ON locations.test_id = $2 AND locations.problem_id = p.id
       WHERE p.id = ANY($1)${visibility}`,
      req.user.role === 'admin' ? [problemIds, testId] : [problemIds, testId, test.created_by]
    );
    const visibleProblemIds = result.rows.map((problem) => problem.id);
    const tagResult = visibleProblemIds.length
      ? await pool.query('SELECT problem_id, tag_id FROM problem_tags WHERE problem_id = ANY($1)', [visibleProblemIds])
      : { rows: [] };
    const tagsByProblem = {};
    for (const row of tagResult.rows) {
      if (!tagsByProblem[row.problem_id]) tagsByProblem[row.problem_id] = [];
      tagsByProblem[row.problem_id].push(row.tag_id);
    }
    const tagNames = await pool.query('SELECT id, name FROM tags WHERE id = ANY($1)', [
      [...new Set(tagResult.rows.map(r => r.tag_id))]
    ]);
    const tagMap = Object.fromEntries(tagNames.rows.map(r => [r.id, r.name]));
    const problemMap = Object.fromEntries(result.rows.map(p => [p.id, p]));
    const ordered = problemIds.map(id => problemMap[id]).filter(Boolean);
    const problems = ordered.map(p => ({
      ...p,
      sourceDocumentId: test.source_document_id ?? null,
      sourcePage: p.test_source_page ?? p.source_page ?? null,
      pdfPage: p.test_pdf_page ?? p.student_pdf_page ?? null,
      sourcePages: p.test_source_pages ?? p.source_pages ?? [],
      pdfPages: p.test_pdf_pages ?? p.student_pdf_pages ?? [],
      tag_ids: tagsByProblem[p.id] || [],
      tag_names: (tagsByProblem[p.id] || []).map(tid => tagMap[tid]).filter(Boolean)
    }));
    res.json(problems);
  } catch (error) {
    console.error('Get test problems error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Deliver only the sanitized, question-pages-only PDF for this specific test.
// Unlike the image upload route, this endpoint authorizes against the test and
// active student session on every request (including PDF byte-range requests).
app.get('/api/tests/:id/pdf', authenticateToken, async (req, res) => {
  const testId = Number(req.params.id);
  if (!Number.isSafeInteger(testId) || testId < 1) return res.status(400).send('Invalid test id');
  try {
    const result = await pool.query(
      `SELECT t.id, t.created_by, t.source_document_id, d.student_data
       FROM tests t
       JOIN source_documents d ON d.id = t.source_document_id
       WHERE t.id = $1 AND d.rights_confirmed = true AND d.created_by = t.created_by`,
      [testId]
    );
    const test = result.rows[0];
    if (!test) return res.status(404).send('PDF not found');

    if (req.user.role === 'teacher') {
      if (req.user.id !== test.created_by) return res.status(403).send('Forbidden');
    } else if (req.user.role === 'student') {
      const student = await pool.query('SELECT teacher_id FROM users WHERE id = $1', [req.user.id]);
      if (student.rows[0]?.teacher_id !== test.created_by) return res.status(403).send('Forbidden');
      const sessionResult = await pool.query(
        `SELECT submitted_at,
                expires_at + INTERVAL '30 seconds' < CURRENT_TIMESTAMP AS expired
         FROM test_sessions WHERE test_id = $1 AND student_id = $2`,
        [testId, req.user.id]
      );
      const session = sessionResult.rows[0];
      if (!session) return res.status(409).send('Start this test before opening its PDF');
      if (session.submitted_at) return res.status(403).send('Test already submitted');
      if (session.expired) return res.status(410).send('Test session expired');
    } else {
      return res.status(403).send('Forbidden');
    }

    const pdf = Buffer.isBuffer(test.student_data) ? test.student_data : Buffer.from(test.student_data);
    const total = pdf.length;
    if (!total) return res.status(404).send('PDF not found');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="test-source.pdf"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    const rangeHeader = req.get('range');
    if (!rangeHeader) {
      res.setHeader('Content-Length', String(total));
      return res.status(200).send(pdf);
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || (!match[1] && !match[2])) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    let start;
    let end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      start = Math.max(0, total - suffixLength);
      end = total - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : total - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    end = Math.min(end, total - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return res.end(pdf.subarray(start, end + 1));
  } catch (error) {
    console.error('Test PDF serve error:', error);
    res.status(500).send('Unable to load PDF');
  }
});

// Get all attempts for a test (teacher only; only their students)
app.get('/api/tests/:id/attempts', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  
  try {
    const result = await pool.query(
      `SELECT ta.*, u.username 
       FROM test_attempts ta 
       JOIN users u ON ta.student_id = u.id 
       JOIN tests t ON t.id = ta.test_id
       WHERE ta.test_id = $1 AND t.created_by = $2 AND u.teacher_id = $2
       ORDER BY ta.score DESC`,
      [req.params.id, req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Start or resume a server-timed test session for this student.
app.post('/api/tests/:id/start', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Student access required' });
  }
  const testId = Number(req.params.id);
  if (!Number.isSafeInteger(testId) || testId < 1) {
    return res.status(400).json({ error: 'Invalid test id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const testResult = await client.query(
      'SELECT id, created_by, time_limit FROM tests WHERE id = $1 FOR SHARE',
      [testId]
    );
    const test = testResult.rows[0];
    if (!test) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Test not found' });
    }
    const studentResult = await client.query('SELECT teacher_id FROM users WHERE id = $1', [req.user.id]);
    if (studentResult.rows[0]?.teacher_id !== test.created_by) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only take tests assigned by your teacher' });
    }
    const attemptResult = await client.query(
      'SELECT id FROM test_attempts WHERE test_id = $1 AND student_id = $2',
      [testId, req.user.id]
    );
    if (attemptResult.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Test already submitted' });
    }

    await client.query(
      `INSERT INTO test_sessions (test_id, student_id, started_at, expires_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($3 * INTERVAL '1 minute'))
       ON CONFLICT (test_id, student_id) DO NOTHING`,
      [testId, req.user.id, test.time_limit]
    );
    const sessionResult = await client.query(
      `SELECT
              FLOOR(EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000)::bigint AS remaining_ms
       FROM test_sessions WHERE test_id = $1 AND student_id = $2`,
      [testId, req.user.id]
    );
    const session = sessionResult.rows[0];
    const remainingMs = Number(session.remaining_ms);
    await client.query('COMMIT');
    if (remainingMs < -30_000) {
      return res.status(410).json({ error: 'The time limit for this test has passed. Your teacher can assign it again if needed.' });
    }
    res.json({
      remainingMs: Math.max(0, remainingMs)
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Start test error:', error);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Submit test
app.post('/api/tests/:id/submit', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Student access required' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { answers } = req.body;
    const testId = req.params.id;
    
    // Check if already submitted
    const existingAttempt = await client.query(
      'SELECT * FROM test_attempts WHERE test_id = $1 AND student_id = $2',
      [testId, req.user.id]
    );
    
    if (existingAttempt.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Test already submitted' });
    }
    
    // Get test and ensure student can take it (only their teacher's tests)
    const testResult = await client.query('SELECT * FROM tests WHERE id = $1', [testId]);
    const test = testResult.rows[0];
    if (!test) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Test not found' });
    }
    const studentRow = await client.query('SELECT teacher_id FROM users WHERE id = $1', [req.user.id]);
    if (studentRow.rows[0]?.teacher_id !== test.created_by) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only submit tests assigned by your teacher' });
    }

    const sessionResult = await client.query(
      `SELECT submitted_at,
              expires_at + INTERVAL '30 seconds' < CURRENT_TIMESTAMP AS expired
       FROM test_sessions WHERE test_id = $1 AND student_id = $2 FOR UPDATE`,
      [testId, req.user.id]
    );
    const testSession = sessionResult.rows[0];
    if (!testSession) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Start this test before submitting answers' });
    }
    if (testSession.submitted_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Test already submitted' });
    }
    if (testSession.expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'The test time limit has passed. Your answers could not be submitted.' });
    }
    
    const problemsResult = await client.query(
      'SELECT * FROM problems WHERE id = ANY($1)',
      [test.problem_ids]
    );
    const problems = problemsResult.rows;

    // Get problem -> tags mapping for subject-specific ELO
    const tagRows = await client.query(
      'SELECT problem_id, tag_id FROM problem_tags WHERE problem_id = ANY($1)',
      [test.problem_ids]
    );
    const tagsByProblem = {};
    for (const r of tagRows.rows) {
      if (!tagsByProblem[r.problem_id]) tagsByProblem[r.problem_id] = [];
      tagsByProblem[r.problem_id].push(r.tag_id);
    }

    // Batch ELO: use same problem ELOs for everyone on this test (snapshot on first submit)
    let snapshot = test.problem_elo_snapshot;
    if (typeof snapshot === 'string') try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; }
    if (!snapshot || typeof snapshot !== 'object' || Object.keys(snapshot).length === 0) {
      snapshot = {};
      for (const p of problems) snapshot[p.id] = p.elo;
      await client.query(
        'UPDATE tests SET problem_elo_snapshot = $1 WHERE id = $2',
        [JSON.stringify(snapshot), testId]
      );
    }
    // Use snapshot ELO for grading (so all students in batch face same difficulties)
    const getProblemElo = (problem) => snapshot[problem.id] ?? problem.elo;
    
    // Get current user ELO and attempt count (for dynamic K)
    const userResult = await client.query(
      'SELECT u.elo, (SELECT COUNT(*)::int FROM elo_history WHERE user_id = $1) AS attempt_count FROM users u WHERE u.id = $1',
      [req.user.id]
    );
    const currentUserElo = userResult.rows[0].elo;
    let userAttemptCount = userResult.rows[0].attempt_count || 0;
    
    // Grade and calculate ELO using snapshot problem ELOs
    let score = 0;
    const results = {};
    let newUserElo = currentUserElo;
    
    const TOLERANCE = 0.001;
    for (const problem of problems) {
      const isCorrect = compareAnswers(answers[problem.id], problem.answer, TOLERANCE);
      results[problem.id] = isCorrect;
      
      if (isCorrect) score++;
      
      const problemElo = getProblemElo(problem);
      const outcome = isCorrect ? 1 : 0;
      const userK = getKFactor(32, userAttemptCount);
      const problemK = getKFactor(24, problem.times_used || 0);
      const tempNewUserElo = calculateELO(newUserElo, problemElo, outcome, userK);
      const newProblemElo = calculateELO(problemElo, newUserElo, 1 - outcome, problemK);
      userAttemptCount++;
      
      // Update problem in DB (global difficulty still evolves)
      await client.query(
        `UPDATE problems 
         SET elo = $1, 
             times_used = times_used + 1, 
             times_correct = times_correct + $2 
         WHERE id = $3`,
        [newProblemElo, isCorrect ? 1 : 0, problem.id]
      );
      
      // Record ELO history (snapshot ELO used for grading)
      await client.query(
        `INSERT INTO elo_history 
         (user_id, problem_id, old_user_elo, new_user_elo, old_problem_elo, new_problem_elo, was_correct) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user.id, problem.id, newUserElo, tempNewUserElo, problemElo, newProblemElo, isCorrect]
      );

      // Update subject-specific (tag) ELO for each tag on this problem
      const problemTagIds = tagsByProblem[problem.id] || [];
      for (const tagId of problemTagIds) {
        const tagEloRows = await client.query(
          'SELECT elo, COALESCE(attempt_count, 0) AS attempt_count FROM student_tag_elo WHERE user_id = $1 AND tag_id = $2',
          [req.user.id, tagId]
        );
        let currentTagElo = tagEloRows.rows[0]?.elo ?? 1500;
        const tagAttemptCount = tagEloRows.rows[0]?.attempt_count ?? 0;
        const tagK = getKFactor(32, tagAttemptCount);
        const newTagElo = calculateELO(currentTagElo, problemElo, outcome, tagK);
        await client.query(
          `INSERT INTO student_tag_elo (user_id, tag_id, elo, attempt_count) VALUES ($1, $2, $3, 1)
           ON CONFLICT (user_id, tag_id) DO UPDATE SET elo = $3, attempt_count = student_tag_elo.attempt_count + 1`,
          [req.user.id, tagId, newTagElo]
        );
      }
      
      newUserElo = tempNewUserElo;
    }
    
    // Update user ELO
    await client.query(
      'UPDATE users SET elo = $1 WHERE id = $2',
      [newUserElo, req.user.id]
    );
    
    // Record attempt
    const attemptResult = await client.query(
      `INSERT INTO test_attempts 
       (test_id, student_id, answers, results, score, total, elo_before, elo_after) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING *`,
      [testId, req.user.id, JSON.stringify(answers), JSON.stringify(results), score, problems.length, currentUserElo, newUserElo]
    );

    await client.query(
      'UPDATE test_sessions SET submitted_at = CURRENT_TIMESTAMP WHERE test_id = $1 AND student_id = $2',
      [testId, req.user.id]
    );
    
    await client.query('COMMIT');
    
    res.json({
      attempt: attemptResult.rows[0],
      eloChange: newUserElo - currentUserElo
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Submit test error:', error);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Get all students (teacher only; only students they registered) with subject ELOs
app.get('/api/students', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  
  try {
    const result = await pool.query(
      'SELECT id, username, elo FROM users WHERE role = $1 AND teacher_id = $2 ORDER BY elo DESC',
      ['student', req.user.id]
    );
    const students = result.rows;
    const mathcounts = await pool.query(
      `SELECT ta.student_id, t.test_type, ta.score
       FROM test_attempts ta
       JOIN tests t ON t.id = ta.test_id
       JOIN users u ON u.id = ta.student_id AND u.role = 'student' AND u.teacher_id = $1`,
      [req.user.id]
    );
    const byStudent = {};
    for (const r of mathcounts.rows) {
      if (!byStudent[r.student_id]) byStudent[r.student_id] = { sprint: 0, target: 0 };
      if (r.test_type === 'target') byStudent[r.student_id].target += r.score;
      else byStudent[r.student_id].sprint += r.score;
    }
    for (const s of students) {
      const m = byStudent[s.id] || { sprint: 0, target: 0 };
      s.cumulative_score = m.sprint + 2 * m.target;
    }
    const tagElos = await pool.query(
      `SELECT ste.user_id, t.name, ste.elo FROM student_tag_elo ste
       JOIN tags t ON t.id = ste.tag_id
       JOIN users u ON u.id = ste.user_id AND u.role = 'student' AND u.teacher_id = $1
       ORDER BY t.name`,
      [req.user.id]
    );
    const byUser = {};
    for (const r of tagElos.rows) {
      if (!byUser[r.user_id]) byUser[r.user_id] = [];
      byUser[r.user_id].push({ name: r.name, elo: r.elo });
    }
    for (const s of students) {
      s.tag_elos = byUser[s.id] || [];
    }
    students.sort((a, b) => (b.mathcounts_score ?? 0) - (a.mathcounts_score ?? 0));
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single student profile (teacher only; must be their student)
app.get('/api/students/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  const studentId = parseInt(req.params.id, 10);
  if (isNaN(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
  try {
    const studentResult = await pool.query(
      'SELECT id, username, elo FROM users WHERE id = $1 AND role = $2 AND teacher_id = $3',
      [studentId, 'student', req.user.id]
    );
    const student = studentResult.rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const tagElos = await pool.query(
      `SELECT t.name, ste.elo FROM student_tag_elo ste
       JOIN tags t ON t.id = ste.tag_id WHERE ste.user_id = $1 ORDER BY t.name`,
      [studentId]
    );
    student.tag_elos = tagElos.rows;

    const mathcounts = await pool.query(
      `SELECT t.test_type, ta.score FROM test_attempts ta
       JOIN tests t ON t.id = ta.test_id WHERE ta.student_id = $1`,
      [studentId]
    );
    let sprint = 0, target = 0;
    for (const r of mathcounts.rows) {
      if (r.test_type === 'target') target += r.score;
      else sprint += r.score;
    }
    student.cumulative_score = sprint + 2 * target;

    const attemptsResult = await pool.query(
      `SELECT ta.id, ta.test_id, ta.answers, ta.results, ta.completed_at, t.name AS test_name, t.problem_ids
       FROM test_attempts ta
       JOIN tests t ON t.id = ta.test_id
       WHERE ta.student_id = $1
       ORDER BY ta.completed_at DESC
       LIMIT 30`,
      [studentId]
    );
    const problemHistory = [];
    const seenProblemAttempts = new Set();
    for (const a of attemptsResult.rows) {
      const answers = typeof a.answers === 'string' ? JSON.parse(a.answers) : (a.answers || {});
      const results = typeof a.results === 'string' ? JSON.parse(a.results) : (a.results || {});
      const problemIds = a.problem_ids || [];
      if (problemIds.length === 0) continue;
      const probsResult = await pool.query(
        'SELECT id, question, answer FROM problems WHERE id = ANY($1)',
        [problemIds]
      );
      const probMap = Object.fromEntries(probsResult.rows.map(p => [p.id, p]));
      for (const pid of problemIds) {
        const p = probMap[pid];
        if (!p) continue;
        const key = `${a.id}-${pid}`;
        if (seenProblemAttempts.has(key)) continue;
        seenProblemAttempts.add(key);
        const correct = results[pid] === true;
        const studentAnswer = answers[pid] ?? '';
        problemHistory.push({
          problem_id: pid,
          question: p.question,
          image_url: p.image_url,
          correct,
          student_answer: correct ? null : studentAnswer,
          test_name: a.test_name,
          completed_at: a.completed_at
        });
      }
    }
    problemHistory.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
    student.problem_history = problemHistory.slice(0, 50);
    res.json(student);
  } catch (error) {
    console.error('Get student profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Register a student (teacher only)
app.post('/api/students', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, role, teacher_id) VALUES ($1, $2, $3, $4) RETURNING id, username, elo',
      [username.trim(), passwordHash, 'student', req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Username already taken' });
    }
    console.error('Register student error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve the built React app from the API origin in the one-service production setup.
if (fs.existsSync(frontendDistDir)) {
  app.use(express.static(frontendDistDir, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path === '/uploads' || req.path.startsWith('/uploads/')) {
      return next();
    }
    res.sendFile(path.join(frontendDistDir, 'index.html'));
  });
}

// Initialize database and start server
async function startServer() {
  try {
    validateJwtSecret();
    await initDatabase();
    await seedDatabase();
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
