import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Database initialization
export async function initDatabase() {
  const client = await pool.connect();
  
  try {
    // Run migrations that add columns to existing tables in their own transaction
    // so they commit even if later steps fail (e.g. on existing Render DBs)
    try {
      await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS image_url TEXT');
      console.log('Problems image_url column ensured');
    } catch (migErr) {
      console.warn('Migration image_url (non-fatal):', migErr.message);
    }
    try {
      await client.query('ALTER TABLE tests ADD COLUMN IF NOT EXISTS problem_elo_snapshot JSONB');
      console.log('Tests problem_elo_snapshot column ensured');
    } catch (migErr) {
      console.warn('Migration problem_elo_snapshot (non-fatal):', migErr.message);
    }
    try {
      await client.query(`ALTER TABLE tests ADD COLUMN IF NOT EXISTS test_type VARCHAR(20) DEFAULT 'sprint'`);
      await client.query(`UPDATE tests SET test_type = 'sprint' WHERE test_type IS NULL`);
      console.log('Tests test_type column ensured');
    } catch (migErr) {
      console.warn('Migration test_type (non-fatal):', migErr.message);
    }
    try {
      await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS source TEXT');
      console.log('Problems source column ensured');
    } catch (migErr) {
      console.warn('Migration problems source (non-fatal):', migErr.message);
    }
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS folders (
          id SERIAL PRIMARY KEY,
          name VARCHAR(200) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id)');
      await client.query(`INSERT INTO folders (name) SELECT 'Uncategorized' WHERE NOT EXISTS (SELECT 1 FROM folders LIMIT 1)`);
      console.log('Folders table and problems.folder_id ensured');
    } catch (migErr) {
      console.warn('Migration folders (non-fatal):', migErr.message);
    }
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS tags (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL UNIQUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS problem_tags (
          problem_id INTEGER REFERENCES problems(id) ON DELETE CASCADE,
          tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (problem_id, tag_id)
        )
      `);
      console.log('Tags and problem_tags tables ensured');
    } catch (migErr) {
      console.warn('Migration tags (non-fatal):', migErr.message);
    }
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS student_tag_elo (
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
          elo INTEGER NOT NULL DEFAULT 1500,
          PRIMARY KEY (user_id, tag_id)
        )
      `);
      await client.query('ALTER TABLE student_tag_elo ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0');
      console.log('student_tag_elo table ensured');
    } catch (migErr) {
      console.warn('Migration student_tag_elo (non-fatal):', migErr.message);
    }
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS uploads (
          id SERIAL PRIMARY KEY,
          data TEXT NOT NULL,
          filename VARCHAR(255) NOT NULL,
          content_type VARCHAR(100) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('Uploads table ensured');
    } catch (migErr) {
      console.warn('Migration uploads (non-fatal):', migErr.message);
    }

    await client.query('BEGIN');
    
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
        elo INTEGER DEFAULT 1500,
        teacher_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES users(id)
    `);
    
    // Problems table
    await client.query(`
      CREATE TABLE IF NOT EXISTS problems (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        answer NUMERIC NOT NULL,
        topic VARCHAR(100),
        image_url TEXT,
        source TEXT,
        elo INTEGER DEFAULT 1500,
        times_used INTEGER DEFAULT 0,
        times_correct INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Tests table (problem_elo_snapshot = frozen ELOs for this test so all students see same difficulties)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tests (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        problem_ids INTEGER[] NOT NULL,
        due_date DATE NOT NULL,
        time_limit INTEGER NOT NULL,
        created_by INTEGER REFERENCES users(id),
        problem_elo_snapshot JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Test attempts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS test_attempts (
        id SERIAL PRIMARY KEY,
        test_id INTEGER REFERENCES tests(id),
        student_id INTEGER REFERENCES users(id),
        answers JSONB NOT NULL,
        results JSONB NOT NULL,
        score INTEGER NOT NULL,
        total INTEGER NOT NULL,
        elo_before INTEGER NOT NULL,
        elo_after INTEGER NOT NULL,
        completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(test_id, student_id)
      )
    `);
    
    // ELO history table
    await client.query(`
      CREATE TABLE IF NOT EXISTS elo_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        problem_id INTEGER REFERENCES problems(id),
        old_user_elo INTEGER NOT NULL,
        new_user_elo INTEGER NOT NULL,
        old_problem_elo INTEGER NOT NULL,
        new_problem_elo INTEGER NOT NULL,
        was_correct BOOLEAN NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Ensure problem_id FK cascades on delete (so sample problems can be deleted)
    await client.query(`
      ALTER TABLE elo_history DROP CONSTRAINT IF EXISTS elo_history_problem_id_fkey
    `);
    await client.query(`
      ALTER TABLE elo_history
      ADD CONSTRAINT elo_history_problem_id_fkey
      FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
    `);
    
    await client.query('COMMIT');
    console.log('Database tables created successfully');

    // Migrations that need users to exist (run after main schema)
    try {
      await client.query('ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)');
      await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)');
      await client.query('ALTER TABLE tags ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)');
      await client.query('ALTER TABLE uploads ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)');
      await client.query('ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_name_key');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS tags_name_public ON tags (name) WHERE created_by IS NULL');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS tags_name_teacher ON tags (name, created_by) WHERE created_by IS NOT NULL');
      console.log('created_by columns and tag indexes ensured');
    } catch (migErr) {
      console.warn('Migration created_by (non-fatal):', migErr.message);
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Seed initial data
export async function seedDatabase() {
  const bcrypt = await import('bcrypt');
  const client = await pool.connect();
  
  try {
    // Check if data already exists
    const userCheck = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCheck.rows[0].count) > 0) {
      console.log('Database already seeded, skipping...');
      return;
    }
    
    await client.query('BEGIN');
    
    // Create default users
    const adminHash = await bcrypt.hash('admin123', 10);
    const teacherHash = await bcrypt.hash('teacher123', 10);
    const studentHash = await bcrypt.hash('student123', 10);
    
    await client.query(`
      INSERT INTO users (username, password_hash, role, elo) VALUES
      ('admin', $1, 'admin', 1500),
      ('teacher1', $2, 'teacher', 1500),
      ('student1', $3, 'student', 1500),
      ('student2', $3, 'student', 1450),
      ('student3', $3, 'student', 1520)
    `, [adminHash, teacherHash, studentHash]);
    await client.query(`
      UPDATE users SET teacher_id = (SELECT id FROM users WHERE username = 'teacher1' LIMIT 1)
      WHERE role = 'student'
    `);
    
    // Create default folder and tags if empty
    const folderCheck = await client.query('SELECT COUNT(*) FROM folders');
    if (parseInt(folderCheck.rows[0].count) === 0) {
      await client.query(`INSERT INTO folders (name) VALUES ('Uncategorized')`);
    }
    const tagCheck = await client.query('SELECT COUNT(*) FROM tags');
    if (parseInt(tagCheck.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO tags (name) VALUES
        ('Algebra'), ('Geometry'), ('Number Theory'), ('Counting'), ('Probability'),
        ('Arithmetic'), ('Exponents'), ('Percentages'), ('Division'), ('Multiplication'),
        ('Square Roots'), ('Fractions')
      `);
    }
    
    // Create sample problems
    await client.query(`
      INSERT INTO problems (question, answer, topic, elo) VALUES
      ('What is 15 × 7?', 105, 'Multiplication', 1400),
      ('What is the square root of 144?', 12, 'Square Roots', 1500),
      ('What is 256 ÷ 16?', 16, 'Division', 1450),
      ('What is 2³ + 5²?', 33, 'Exponents', 1600),
      ('What is 45% of 200?', 90, 'Percentages', 1550),
      ('What is 12 × 12?', 144, 'Multiplication', 1380),
      ('What is √81?', 9, 'Square Roots', 1420),
      ('What is 3⁴?', 81, 'Exponents', 1580),
      ('What is 20% of 150?', 30, 'Percentages', 1480),
      ('What is 144 ÷ 12?', 12, 'Division', 1440),
      ('What is 8 × 9?', 72, 'Multiplication', 1360),
      ('What is √196?', 14, 'Square Roots', 1520),
      ('What is 5³?', 125, 'Exponents', 1620),
      ('What is 75% of 80?', 60, 'Percentages', 1500),
      ('What is 180 ÷ 15?', 12, 'Division', 1460),
      ('What is 13 × 8?', 104, 'Multiplication', 1390),
      ('What is √225?', 15, 'Square Roots', 1540),
      ('What is 10² - 6²?', 64, 'Exponents', 1590),
      ('What is 30% of 250?', 75, 'Percentages', 1510),
      ('What is 324 ÷ 18?', 18, 'Division', 1470)
    `);
    
    await client.query('COMMIT');
    console.log('Database seeded successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error seeding database:', error);
    throw error;
  } finally {
    client.release();
  }
}

export default pool;