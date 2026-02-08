import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import pool, { initDatabase, seedDatabase } from './db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer config for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = (file.mimetype === 'image/png') ? '.png' : (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') ? '.jpg' : '.png';
    cb(null, `problem-${Date.now()}${path.extname(file.originalname) || ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = /image\/(jpeg|jpg|png|gif|webp)/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images (JPEG, PNG, GIF, WebP) are allowed'));
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

// Get current user
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, role, elo, teacher_id FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all problems
app.get('/api/problems', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM problems ORDER BY id'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload image (admin only)
app.post('/api/upload', authenticateToken, upload.single('image'), (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }
  const url = '/uploads/' + req.file.filename;
  res.json({ url });
});

// Create problem (admin only)
app.post('/api/problems', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { question, answer, topic, image_url: imageUrl } = req.body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }
  const answerNum = Number(answer);
  if (answer === undefined || answer === null || answer === '' || Number.isNaN(answerNum)) {
    return res.status(400).json({ error: 'A valid numeric answer is required' });
  }
  try {
    const topicStr = typeof topic === 'string' ? topic.trim() : '';
    const result = await pool.query(
      'INSERT INTO problems (question, answer, topic, image_url) VALUES ($1, $2, $3, $4) RETURNING *',
      [question.trim(), answerNum, topicStr, imageUrl || null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create problem error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Update problem (admin only)
app.put('/api/problems/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { question, answer, topic, image_url: imageUrl } = req.body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }
  const answerNum = Number(answer);
  if (answer === undefined || answer === null || answer === '' || Number.isNaN(answerNum)) {
    return res.status(400).json({ error: 'A valid numeric answer is required' });
  }
  try {
    const topicStr = typeof topic === 'string' ? topic.trim() : '';
    const result = await pool.query(
      'UPDATE problems SET question = $1, answer = $2, topic = $3, image_url = $4 WHERE id = $5 RETURNING *',
      [question.trim(), answerNum, topicStr, imageUrl || null, req.params.id]
    );
    res.json(result.rows[0]);
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
    const { name, problemIds, dueDate, timeLimit } = req.body;
    const result = await pool.query(
      'INSERT INTO tests (name, problem_ids, due_date, time_limit, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, problemIds, dueDate, timeLimit, req.user.id]
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
    
    for (const problem of problems) {
      const userAnswer = parseFloat(answers[problem.id]);
      const isCorrect = Math.abs(userAnswer - parseFloat(problem.answer)) < 0.01;
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

// Get all students (teacher only; only students they registered)
app.get('/api/students', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  
  try {
    const result = await pool.query(
      'SELECT id, username, elo FROM users WHERE role = $1 AND teacher_id = $2 ORDER BY elo DESC',
      ['student', req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
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