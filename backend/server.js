import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import pool, { initDatabase, seedDatabase } from './db.js';
import { parseAnswerToNumber } from './answerUtils.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

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
    const allowed = /image\/(jpeg|jpg|png|gif|webp)/;
    if (allowed.test(file.mimetype)) cb(null, true);
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
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Access denied' });
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

async function attachFolderAndTags(problem) {
  const [folderRow, tagRows] = await Promise.all([
    problem.folder_id ? pool.query('SELECT name FROM folders WHERE id = $1', [problem.folder_id]) : Promise.resolve({ rows: [] }),
    pool.query('SELECT tag_id FROM problem_tags WHERE problem_id = $1', [problem.id])
  ]);
  const tagIds = tagRows.rows.map(r => r.tag_id);
  const tagNames = tagIds.length ? (await pool.query('SELECT id, name FROM tags WHERE id = ANY($1)', [tagIds])).rows : [];
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

// Routes

// Teacher signup
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, elo',
      [username.trim(), passwordHash, 'teacher']
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
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
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
    if (!user) return res.status(404).json({ error: 'User not found' });
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

// Folders (admin: CRUD; teachers: read-only for test creation)
app.get('/api/folders', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM folders ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/folders', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Folder name is required' });
  }
  try {
    const result = await pool.query('INSERT INTO folders (name) VALUES ($1) RETURNING *', [name.trim()]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.put('/api/folders/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Folder name is required' });
  }
  try {
    const result = await pool.query('UPDATE folders SET name = $1 WHERE id = $2 RETURNING *', [name.trim(), req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Folder not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.delete('/api/folders/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid folder id' });
  try {
    await pool.query('UPDATE problems SET folder_id = NULL WHERE folder_id = $1', [id]);
    const del = await pool.query('DELETE FROM folders WHERE id = $1 RETURNING id', [id]);
    if (del.rowCount === 0) return res.status(404).json({ error: 'Folder not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Import problems from PDF (admin only)
// GET handler for diagnostics: if you get 405 here, the route exists; 404 means old deployment
app.get('/api/import-pdf', (_req, res) => {
  res.status(405).json({ error: 'Use POST to import a PDF', ok: true });
});
app.post('/api/import-pdf', authenticateToken, uploadPdf.single('pdf'), async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'No PDF file provided' });
  }
  const answerKey = typeof req.body.answerKey === 'string' ? req.body.answerKey.trim() : '';
  const useAI = req.body.useAI !== 'false' && req.body.useAI !== false;
  try {
    const { importPdfToDatabase } = await import('./pdfImport.js');
    const result = await importPdfToDatabase(req.file.buffer, answerKey, useAI);
    res.json({
      success: true,
      imported: result.imported,
      folderId: result.folderId,
      folderName: result.folderName,
      errors: result.errors,
    });
  } catch (error) {
    console.error('PDF import error:', error);
    res.status(400).json({ error: error.message || 'Import failed' });
  }
});

// Tags (admin + teacher can read)
app.get('/api/tags', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tags ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/tags', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Tag name is required' });
  }
  try {
    const result = await pool.query('INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *', [name.trim()]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Tag already exists' });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.delete('/api/tags/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid tag id' });
  try {
    const del = await pool.query('DELETE FROM tags WHERE id = $1 RETURNING id', [id]);
    if (del.rowCount === 0) return res.status(404).json({ error: 'Tag not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Get all problems (with folder and tags)
app.get('/api/problems', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, f.name as folder_name
      FROM problems p
      LEFT JOIN folders f ON p.folder_id = f.id
      ORDER BY COALESCE(f.name, 'zzz'), p.id
    `);
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

// Upload image (admin only) — store in DB so it survives deploys (free on Render)
app.post('/api/upload', authenticateToken, upload.single('image'), async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'No image file provided' });
  }
  const dataBase64 = req.file.buffer.toString('base64');
  const contentType = req.file.mimetype || 'image/png';
  const filename = req.file.originalname || `problem-${Date.now()}.png`;
  try {
    const result = await pool.query(
      'INSERT INTO uploads (data, filename, content_type) VALUES ($1, $2, $3) RETURNING id',
      [dataBase64, filename, contentType]
    );
    const id = result.rows[0].id;
    res.json({ url: '/uploads/db/' + id });
  } catch (err) {
    console.error('Upload save error:', err);
    res.status(500).json({ error: 'Failed to save image' });
  }
});

// Serve DB-stored image (survives deploys, free) — route must be before /:filename
app.get('/api/uploads/db/:id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send('Bad request');
  try {
    const result = await pool.query('SELECT data, content_type FROM uploads WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).send('Not found');
    const buf = Buffer.from(result.rows[0].data, 'base64');
    res.setHeader('Content-Type', result.rows[0].content_type || 'image/png');
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

// Create problem (admin only)
app.post('/api/problems', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { question, answer, image_url: imageUrl, source, folder_id: folderId, tag_ids: tagIds } = req.body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }
  const answerNum = parseAnswerToNumber(answer);
  if (answerNum === null) {
    return res.status(400).json({ error: 'A valid answer is required (e.g. 42, 3/4, √2, √2/2)' });
  }
  try {
    const sourceStr = typeof source === 'string' ? source.trim() || null : null;
    const fid = folderId != null ? (Number.isInteger(Number(folderId)) ? Number(folderId) : null) : null;
    const result = await pool.query(
      'INSERT INTO problems (question, answer, topic, image_url, source, folder_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [question.trim(), answerNum, '', imageUrl || null, sourceStr, fid]
    );
    const problem = result.rows[0];
    if (Array.isArray(tagIds) && tagIds.length > 0) {
      const validIds = tagIds.filter(id => Number.isInteger(Number(id))).map(id => Number(id));
      for (const tid of validIds) {
        await pool.query('INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2) ON CONFLICT (problem_id, tag_id) DO NOTHING', [problem.id, tid]);
      }
    }
    const withMeta = await attachFolderAndTags(problem);
    res.json(withMeta);
  } catch (error) {
    console.error('Create problem error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Bulk move and bulk delete must be defined BEFORE /:id routes (otherwise "bulk" matches as :id)
app.put('/api/problems/bulk-move', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { ids, folder_id: folderId } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const validIds = ids.map(id => parseInt(id, 10)).filter(n => Number.isInteger(n) && n > 0);
  if (validIds.length === 0) {
    return res.status(400).json({ error: 'No valid problem ids' });
  }
  const fid = folderId != null ? (Number.isInteger(Number(folderId)) ? Number(folderId) : null) : null;
  try {
    const result = await pool.query(
      'UPDATE problems SET folder_id = $1 WHERE id = ANY($2) RETURNING id',
      [fid, validIds]
    );
    res.json({ updated: result.rowCount });
  } catch (error) {
    console.error('Bulk move error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.delete('/api/problems/bulk', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
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
    for (const id of validIds) {
      await client.query(
        'UPDATE tests SET problem_ids = array_remove(problem_ids, $1) WHERE $1 = ANY(problem_ids)',
        [id]
      );
    }
    const del = await client.query('DELETE FROM problems WHERE id = ANY($1) RETURNING id', [validIds]);
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

// Update problem (admin only)
app.put('/api/problems/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { question, answer, image_url: imageUrl, source, folder_id: folderId, tag_ids: tagIds } = req.body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }
  const answerNum = parseAnswerToNumber(answer);
  if (answerNum === null) {
    return res.status(400).json({ error: 'A valid answer is required (e.g. 42, 3/4, √2, √2/2)' });
  }
  try {
    const sourceStr = typeof source === 'string' ? source.trim() || null : null;
    const fid = folderId != null ? (Number.isInteger(Number(folderId)) ? Number(folderId) : null) : null;
    const result = await pool.query(
      'UPDATE problems SET question = $1, answer = $2, topic = $3, image_url = $4, source = $5, folder_id = $6 WHERE id = $7 RETURNING *',
      [question.trim(), answerNum, '', imageUrl || null, sourceStr, fid, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Problem not found' });
    const problem = result.rows[0];
    await pool.query('DELETE FROM problem_tags WHERE problem_id = $1', [problem.id]);
    if (Array.isArray(tagIds) && tagIds.length > 0) {
      const validIds = tagIds.filter(id => Number.isInteger(Number(id))).map(id => Number(id));
      for (const tid of validIds) {
        await pool.query('INSERT INTO problem_tags (problem_id, tag_id) VALUES ($1, $2)', [problem.id, tid]);
      }
    }
    const withMeta = await attachFolderAndTags(problem);
    res.json(withMeta);
  } catch (error) {
    console.error('Update problem error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Delete problem (admin only)
app.delete('/api/problems/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'Invalid problem id' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE tests SET problem_ids = array_remove(problem_ids, $1) WHERE $1 = ANY(problem_ids)',
      [id]
    );
    const del = await client.query('DELETE FROM problems WHERE id = $1 RETURNING id', [id]);
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
        'SELECT * FROM tests WHERE created_by = $1 ORDER BY created_at DESC',
        [teacherId]
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
    const type = testType === 'target' ? 'target' : 'sprint';
    const result = await pool.query(
      'INSERT INTO tests (name, problem_ids, due_date, time_limit, created_by, test_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, problemIds, dueDate, timeLimit, req.user.id, type]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
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
    
    // Get current user ELO
    const userResult = await client.query('SELECT elo FROM users WHERE id = $1', [req.user.id]);
    const currentUserElo = userResult.rows[0].elo;
    
    // Grade and calculate ELO using snapshot problem ELOs
    let score = 0;
    const results = {};
    let newUserElo = currentUserElo;
    
    const TOLERANCE = 0.001;
    for (const problem of problems) {
      const userAnswer = parseAnswerToNumber(answers[problem.id]);
      const correctAnswer = parseFloat(problem.answer);
      const isCorrect = userAnswer !== null && Math.abs(userAnswer - correctAnswer) < TOLERANCE;
      results[problem.id] = isCorrect;
      
      if (isCorrect) score++;
      
      const problemElo = getProblemElo(problem);
      const outcome = isCorrect ? 1 : 0;
      const tempNewUserElo = calculateELO(newUserElo, problemElo, outcome, 32);
      const newProblemElo = calculateELO(problemElo, newUserElo, 1 - outcome, 16);
      
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
          'SELECT elo FROM student_tag_elo WHERE user_id = $1 AND tag_id = $2',
          [req.user.id, tagId]
        );
        let currentTagElo = tagEloRows.rows[0]?.elo ?? 1500;
        const newTagElo = calculateELO(currentTagElo, problemElo, outcome, 32);
        await client.query(
          `INSERT INTO student_tag_elo (user_id, tag_id, elo) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, tag_id) DO UPDATE SET elo = $3`,
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

// Initialize database and start server
async function startServer() {
  try {
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