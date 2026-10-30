import pg from 'pg';
import dotenv from 'dotenv';
import { createSecureContext } from 'node:tls';
import { randomBytes } from 'crypto';

dotenv.config();

const { Pool } = pg;

function configuredDatabaseCa() {
  const encoded = process.env.DATABASE_SSL_CA_BASE64?.trim();
  if (!encoded) return undefined;
  const compact = encoded.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('DATABASE_SSL_CA_BASE64 must contain a base64-encoded PEM CA certificate');
  }
  const pem = Buffer.from(compact, 'base64').toString('utf8');
  const canonicalBase64 = Buffer.from(pem, 'utf8').toString('base64').replace(/=+$/, '');
  const suppliedBase64 = compact.replace(/=+$/, '');
  const certBlocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  const outsideCerts = pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim();
  if (canonicalBase64 !== suppliedBase64 || certBlocks.length === 0 || outsideCerts) {
    throw new Error('DATABASE_SSL_CA_BASE64 must contain a valid base64-encoded PEM CA certificate');
  }
  try {
    createSecureContext({ ca: pem });
  } catch {
    throw new Error('DATABASE_SSL_CA_BASE64 must contain a valid base64-encoded PEM CA certificate');
  }
  return pem;
}

const databaseCa = configuredDatabaseCa();
const isProduction = process.env.NODE_ENV === 'production';

function productionDatabaseUrl() {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl) return configuredUrl;
  let parsedUrl;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL in production');
  }
  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL in production');
  }
  const sslParameters = new Set(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword']);
  for (const key of [...parsedUrl.searchParams.keys()]) {
    if (sslParameters.has(key.toLowerCase())) parsedUrl.searchParams.delete(key);
  }
  return parsedUrl.toString();
}

const databaseUrl = isProduction ? productionDatabaseUrl() : process.env.DATABASE_URL;
const databaseSsl = isProduction
  ? { rejectUnauthorized: true, ...(databaseCa ? { ca: databaseCa } : {}) }
  : false;

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseSsl
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
      await client.query('ALTER TABLE tests ADD COLUMN IF NOT EXISTS solutions_link TEXT');
      await client.query('ALTER TABLE tests ADD COLUMN IF NOT EXISTS answers_released BOOLEAN DEFAULT false');
      console.log('Tests solutions_link and answers_released columns ensured');
    } catch (migErr) {
      console.warn('Migration solutions_link/answers_released (non-fatal):', migErr.message);
    }
    try {
      await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS source TEXT');
      console.log('Problems source column ensured');
    } catch (migErr) {
      console.warn('Migration problems source (non-fatal):', migErr.message);
    }
    try {
      await client.query(`
        ALTER TABLE problems 
        ALTER COLUMN answer TYPE TEXT 
        USING answer::text
      `);
      console.log('Problems answer column migrated to TEXT');
    } catch (migErr) {
      console.warn('Migration answer to TEXT (non-fatal):', migErr.message);
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
        answer TEXT NOT NULL,
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

    // Private, rights-attested source documents. Keep the original available
    // only to the owning teacher and store a separate question-pages-only copy
    // for test delivery.
    await client.query(`
      CREATE TABLE IF NOT EXISTS source_documents (
        id SERIAL PRIMARY KEY,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_title VARCHAR(200) NOT NULL,
        source_url TEXT,
        license_basis VARCHAR(40) NOT NULL CHECK (license_basis IN ('teacher_created', 'open_license', 'written_permission')),
        license_name VARCHAR(200),
        permission_reference TEXT,
        rights_confirmed BOOLEAN NOT NULL DEFAULT false,
        gemini_allowed BOOLEAN NOT NULL DEFAULT false,
        original_data BYTEA NOT NULL,
        student_data BYTEA NOT NULL,
        original_sha256 VARCHAR(64) NOT NULL,
        original_size INTEGER NOT NULL CHECK (original_size > 0 AND original_size <= 15728640),
        student_size INTEGER NOT NULL CHECK (student_size > 0 AND student_size <= 15728640),
        original_pages INTEGER NOT NULL CHECK (original_pages BETWEEN 1 AND 60),
        student_pages INTEGER NOT NULL CHECK (student_pages BETWEEN 1 AND 60),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE source_documents ADD COLUMN IF NOT EXISTS license_name VARCHAR(200)');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS pdf_document_id INTEGER REFERENCES source_documents(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS source_page INTEGER CHECK (source_page IS NULL OR source_page > 0)');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS student_pdf_page INTEGER CHECK (student_pdf_page IS NULL OR student_pdf_page > 0)');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS source_pages INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[]');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS student_pdf_pages INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[]');
    await client.query('ALTER TABLE tests ADD COLUMN IF NOT EXISTS source_document_id INTEGER REFERENCES source_documents(id) ON DELETE SET NULL');
    await client.query(`
      CREATE TABLE IF NOT EXISTS test_problem_pdf_locations (
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        source_page INTEGER NOT NULL CHECK (source_page > 0),
        pdf_page INTEGER NOT NULL CHECK (pdf_page > 0),
        source_pages INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
        pdf_pages INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
        PRIMARY KEY (test_id, problem_id)
      )
    `);
    await client.query('ALTER TABLE test_problem_pdf_locations ADD COLUMN IF NOT EXISTS source_pages INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[]');
    await client.query('ALTER TABLE test_problem_pdf_locations ADD COLUMN IF NOT EXISTS pdf_pages INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[]');

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_rate_limit_buckets (
        bucket_key VARCHAR(100) PRIMARY KEY,
        window_started_at TIMESTAMPTZ NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count >= 0)
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS test_sessions (
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        submitted_at TIMESTAMPTZ,
        PRIMARY KEY (test_id, student_id),
        CHECK (expires_at > started_at)
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
    await client.query('ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)');
    await client.query('ALTER TABLE tags ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)');
    await client.query('ALTER TABLE uploads ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)');
    await client.query('ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_name_key');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS tags_name_public ON tags (name) WHERE created_by IS NULL');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS tags_name_teacher ON tags (name, created_by) WHERE created_by IS NOT NULL');
    console.log('created_by columns and tag indexes ensured');
    try {
      await client.query('ALTER TABLE tags ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT false');
      const systemTagNames = ['Algebra', 'Arithmetic', 'Counting', 'Geometry', 'Number Theory', 'Probability'];
      for (const name of systemTagNames) {
        const exists = await client.query('SELECT 1 FROM tags WHERE name = $1', [name]);
        if (exists.rows.length === 0) {
          await client.query(
            'INSERT INTO tags (name, is_system, created_by) VALUES ($1, true, NULL)',
            [name]
          );
        } else {
          await client.query('UPDATE tags SET is_system = true WHERE name = $1', [name]);
        }
      }
      console.log('System tags ensured');
    } catch (migErr) {
      console.warn('Migration system tags (non-fatal):', migErr.message);
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
    // Never create the historical demo accounts in production. A fresh
    // production database can receive one explicitly configured administrator.
    const userCheck = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCheck.rows[0].count) > 0) {
      console.log('Database already seeded, skipping...');
      return;
    }

    if (process.env.NODE_ENV === 'production') {
      const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
      const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
      if (!username && !password) {
        console.log('No users exist; production bootstrap admin is not configured, skipping seed.');
        return;
      }
      if (!username || !password) {
        throw new Error('Set both BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD to create the initial production admin.');
      }
      if (username.length > 50 || username.length < 3) {
        throw new Error('BOOTSTRAP_ADMIN_USERNAME must be between 3 and 50 characters.');
      }
      if (password.length < 12) {
        throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
      }

      await client.query('BEGIN');
      const passwordHash = await bcrypt.hash(password, 12);
      await client.query(
        "INSERT INTO users (username, password_hash, role, elo) VALUES ($1, $2, 'admin', 1500)",
        [username, passwordHash]
      );
      await client.query('COMMIT');
      console.log('Initial production administrator created from explicit bootstrap credentials.');
      return;
    }

    // Demo identities and sample content are strictly for local development.
    // Unknown or unset NODE_ENV values must never fall through to demo seeding.
    if (process.env.NODE_ENV !== 'development') {
      console.log(`NODE_ENV is ${process.env.NODE_ENV || 'unset'}; skipping demo seed.`);
      return;
    }
    
    await client.query('BEGIN');
    
    // Generate one-time local credentials instead of shipping shared defaults.
    const adminPassword = randomBytes(24).toString('base64url');
    const teacherPassword = randomBytes(24).toString('base64url');
    const studentPassword = randomBytes(24).toString('base64url');
    const adminHash = await bcrypt.hash(adminPassword, 10);
    const teacherHash = await bcrypt.hash(teacherPassword, 10);
    const studentHash = await bcrypt.hash(studentPassword, 10);
    
    await client.query(`
      INSERT INTO users (username, password_hash, role, elo) VALUES
      ('admin', $1, 'admin', 1500),
      ('teacher1', $2, 'teacher', 1500),
      ('student1', $3, 'student', 1500),
      ('student2', $3, 'student', 1450),
      ('student3', $3, 'student', 1520)
    `, [adminHash, teacherHash, studentHash]);
    console.log(`Local development credentials (store privately): admin / ${adminPassword}; teacher1 / ${teacherPassword}; students / ${studentPassword}`);
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
        INSERT INTO tags (name, is_system) VALUES
        ('Algebra', true), ('Arithmetic', true), ('Counting', true), ('Geometry', true),
        ('Number Theory', true), ('Probability', true)
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
