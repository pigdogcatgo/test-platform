import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool, { initDatabase, seedDatabase } from './db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

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
      'SELECT id, username, role, elo FROM users WHERE id = $1',
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

// Create problem (admin only)
app.post('/api/problems', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  try {
    const { question, answer, topic } = req.body;
    const result = await pool.query(
      'INSERT INTO problems (question, answer, topic) VALUES ($1, $2, $3) RETURNING *',
      [question, answer, topic]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update problem (admin only)
app.put('/api/problems/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  try {
    const { question, answer, topic } = req.body;
    const result = await pool.query(
      'UPDATE problems SET question = $1, answer = $2, topic = $3 WHERE id = $4 RETURNING *',
      [question, answer, topic, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete problem (admin only)
app.delete('/api/problems/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  try {
    await pool.query('DELETE FROM problems WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all tests
app.get('/api/tests', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tests ORDER BY created_at DESC'
    );
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

// Get all attempts for a test (teacher only)
app.get('/api/tests/:id/attempts', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  
  try {
    const result = await pool.query(
      `SELECT ta.*, u.username 
       FROM test_attempts ta 
       JOIN users u ON ta.student_id = u.id 
       WHERE ta.test_id = $1 
       ORDER BY ta.score DESC`,
      [req.params.id]
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
    
    // Get test and problems
    const testResult = await client.query('SELECT * FROM tests WHERE id = $1', [testId]);
    const test = testResult.rows[0];
    
    const problemsResult = await client.query(
      'SELECT * FROM problems WHERE id = ANY($1)',
      [test.problem_ids]
    );
    const problems = problemsResult.rows;
    
    // Get current user ELO
    const userResult = await client.query('SELECT elo FROM users WHERE id = $1', [req.user.id]);
    const currentUserElo = userResult.rows[0].elo;
    
    // Grade and calculate ELO
    let score = 0;
    const results = {};
    let newUserElo = currentUserElo;
    
    for (const problem of problems) {
      const userAnswer = parseFloat(answers[problem.id]);
      const isCorrect = Math.abs(userAnswer - parseFloat(problem.answer)) < 0.01;
      results[problem.id] = isCorrect;
      
      if (isCorrect) score++;
      
      // Calculate new ELOs
      const outcome = isCorrect ? 1 : 0;
      const tempNewUserElo = calculateELO(newUserElo, problem.elo, outcome, 32);
      const newProblemElo = calculateELO(problem.elo, newUserElo, 1 - outcome, 16);
      
      // Update problem
      await client.query(
        `UPDATE problems 
         SET elo = $1, 
             times_used = times_used + 1, 
             times_correct = times_correct + $2 
         WHERE id = $3`,
        [newProblemElo, isCorrect ? 1 : 0, problem.id]
      );
      
      // Record ELO history
      await client.query(
        `INSERT INTO elo_history 
         (user_id, problem_id, old_user_elo, new_user_elo, old_problem_elo, new_problem_elo, was_correct) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user.id, problem.id, newUserElo, tempNewUserElo, problem.elo, newProblemElo, isCorrect]
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

// Get all students (teacher only)
app.get('/api/students', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  
  try {
    const result = await pool.query(
      'SELECT id, username, elo FROM users WHERE role = $1 ORDER BY elo DESC',
      ['student']
    );
    res.json(result.rows);
  } catch (error) {
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