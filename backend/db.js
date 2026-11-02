import pg from 'pg';
import dotenv from 'dotenv';
import { createSecureContext } from 'node:tls';
import { randomBytes } from 'crypto';
import { DEMO_CATALOG } from './demoCatalog.js';
import { inferCatalogMetadata } from './catalogMetadata.js';

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
const isDemoMode = process.env.DEMO_MODE === 'true';

function productionDatabaseUrl(configuredUrl) {
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

if (isDemoMode && !isProduction) {
  throw new Error('DEMO_MODE=true requires NODE_ENV=production');
}
if (isDemoMode && !process.env.DEMO_DATABASE_URL) {
  throw new Error('DEMO_MODE=true requires DEMO_DATABASE_URL; DATABASE_URL is never used as a fallback');
}

if (isDemoMode && process.env.DATABASE_URL) {
  const demoUrl = new URL(productionDatabaseUrl(process.env.DEMO_DATABASE_URL));
  const productionUrl = new URL(productionDatabaseUrl(process.env.DATABASE_URL));
  const sameDatabase = demoUrl.hostname.toLowerCase() === productionUrl.hostname.toLowerCase()
    && (demoUrl.port || '5432') === (productionUrl.port || '5432')
    && decodeURIComponent(demoUrl.pathname) === decodeURIComponent(productionUrl.pathname);
  if (sameDatabase) {
    throw new Error('DEMO_DATABASE_URL must identify a different normalized database connection than DATABASE_URL');
  }
}

const databaseUrl = isDemoMode
  ? productionDatabaseUrl(process.env.DEMO_DATABASE_URL)
  : (isProduction ? productionDatabaseUrl(process.env.DATABASE_URL) : process.env.DATABASE_URL);
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS teacher_settings (
        teacher_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        student_class_elo_visible BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE teacher_settings ALTER COLUMN student_class_elo_visible SET DEFAULT false');
    await client.query(`
      CREATE TABLE IF NOT EXISTS demo_instance (
        singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton = true),
        teacher_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        teacher_username VARCHAR(50) NOT NULL,
        student_username_prefix VARCHAR(47) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
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
        catalog_formats TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        difficulty SMALLINT,
        year_block VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS folders (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id)');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS catalog_formats TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS difficulty SMALLINT');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS year_block VARCHAR(50)');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS year INTEGER');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS level VARCHAR(50)');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS round VARCHAR(50)');
    await client.query('ALTER TABLE problems ADD COLUMN IF NOT EXISTS problem_number INTEGER');
    const metadataRows = await client.query(`
      SELECT p.id, p.source, f.name AS folder_name
      FROM problems p LEFT JOIN folders f ON f.id = p.folder_id
      WHERE p.year IS NULL OR p.level IS NULL OR p.round IS NULL OR p.problem_number IS NULL
    `);
    for (const problem of metadataRows.rows) {
      const inferred = inferCatalogMetadata(problem.source, problem.folder_name);
      await client.query(
        `UPDATE problems SET year = COALESCE(year, $1), level = COALESCE(level, $2), round = COALESCE(round, $3), problem_number = COALESCE(problem_number, $4) WHERE id = $5`,
        [inferred.year, inferred.level, inferred.round, inferred.problemNumber, problem.id]
      );
    }
    
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
        is_synthetic BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE tests ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false');

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
        is_synthetic BOOLEAN NOT NULL DEFAULT false,
        completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(test_id, student_id)
      )
    `);
    await client.query('ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false');

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
        is_synthetic BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE elo_history ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false');

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
    if (process.env.DEMO_MODE === 'true') {
      if (process.env.NODE_ENV !== 'production') {
        throw new Error('DEMO_MODE=true is only allowed with NODE_ENV=production on the isolated preview service');
      }
      if (process.env.BOOTSTRAP_ADMIN_USERNAME || process.env.BOOTSTRAP_ADMIN_PASSWORD) {
        throw new Error('DEMO_MODE cannot be combined with production administrator bootstrap credentials');
      }
      const teacherUsername = process.env.DEMO_TEACHER_USERNAME?.trim();
      const teacherPassword = process.env.DEMO_TEACHER_PASSWORD;
      const studentUsername = process.env.DEMO_STUDENT_USERNAME?.trim();
      const studentPassword = process.env.DEMO_STUDENT_PASSWORD;
      const validUsername = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]{3,50}$/.test(value);
      const validPassword = (value) => typeof value === 'string'
        && Array.from(value).length >= 12
        && Buffer.byteLength(value, 'utf8') <= 72;
      const generatedStudentNames = validUsername(studentUsername)
        ? [studentUsername, ...Array.from({ length: 4 }, (_, index) => `${studentUsername}-cohort-${String(index + 2).padStart(2, '0')}`)]
        : [];
      if (!validUsername(teacherUsername)
        || !validUsername(studentUsername)
        || studentUsername.length > 40
        || !validPassword(teacherPassword)
        || !validPassword(studentPassword)
        || teacherPassword === studentPassword
        || generatedStudentNames.some((username) => username.toLowerCase() === teacherUsername.toLowerCase())) {
        throw new Error('DEMO_MODE requires distinct, valid DEMO_TEACHER_USERNAME/PASSWORD and DEMO_STUDENT_USERNAME/PASSWORD settings');
      }

      const demoInstance = await client.query('SELECT teacher_id, teacher_username, student_username_prefix FROM demo_instance WHERE singleton = true');
      if (demoInstance.rowCount) {
        const marker = demoInstance.rows[0];
        if (marker.teacher_username !== teacherUsername || marker.student_username_prefix !== studentUsername) {
          throw new Error('DEMO_MODE credentials do not match the initialized dedicated preview database');
        }
        const fixtureState = await client.query(
          `SELECT
             (SELECT COUNT(*)::int FROM users WHERE role = 'teacher' AND id = $1 AND username = $2) AS teachers,
             (SELECT COUNT(*)::int FROM users WHERE role = 'student') AS students,
             (SELECT COUNT(*)::int FROM users WHERE role = 'student' AND teacher_id IS DISTINCT FROM $1) AS misassigned_students,
             (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admins,
             (SELECT COUNT(*)::int FROM problems) AS all_problems,
             (SELECT COUNT(*)::int FROM problems WHERE created_by = $1 AND source = 'Fictional demo catalog') AS catalog_problems,
             (SELECT COUNT(*)::int FROM test_attempts ta JOIN tests t ON t.id = ta.test_id
               WHERE t.created_by = $1 AND t.name = 'Synthetic demo history: Target baseline'
                 AND t.is_synthetic = true AND ta.is_synthetic = true) AS baseline_attempts,
             (SELECT COUNT(*)::int FROM elo_history eh JOIN problems p ON p.id = eh.problem_id
               WHERE eh.is_synthetic = true AND p.created_by = $1) AS synthetic_elo_rows`,
          [marker.teacher_id, teacherUsername]
        );
        const state = fixtureState.rows[0];
        if (state.teachers !== 1 || state.students !== 5 || state.misassigned_students !== 0
          || state.admins !== 0 || state.all_problems !== 30 || state.catalog_problems !== 30
          || state.baseline_attempts !== 5 || state.synthetic_elo_rows < 40) {
          throw new Error('Initialized demo database no longer matches its protected fictional fixture');
        }
        return;
      }

      // DEMO_MODE is a one-time initializer for a dedicated, empty preview DB.
      // Fail startup on any existing user/content instead of ever mixing fixtures
      // into a database that may contain real or historical records.
      const existingData = await client.query(`
        SELECT
          EXISTS (SELECT 1 FROM users) OR
          EXISTS (SELECT 1 FROM problems) OR
          EXISTS (SELECT 1 FROM tests) OR
          EXISTS (SELECT 1 FROM test_attempts) OR
          EXISTS (SELECT 1 FROM test_sessions) OR
          EXISTS (SELECT 1 FROM source_documents) OR
          EXISTS (SELECT 1 FROM uploads) OR
          EXISTS (SELECT 1 FROM folders WHERE created_by IS NOT NULL OR name <> 'Uncategorized') OR
          EXISTS (SELECT 1 FROM tags WHERE created_by IS NOT NULL
            OR name NOT IN ('Algebra', 'Arithmetic', 'Counting', 'Geometry', 'Number Theory', 'Probability')) AS has_data
      `);
      if (existingData.rows[0].has_data) {
        throw new Error('DEMO_MODE requires a fresh dedicated database with no existing users or content');
      }
      if (DEMO_CATALOG.length !== 30 || DEMO_CATALOG.filter((problem) => Array.isArray(problem.formats) && problem.formats.includes('Target')).length < 8) {
        throw new Error('Fictional demo catalog must provide 30 Sprint questions and at least 8 Target questions');
      }

      await client.query('BEGIN');
      const teacherHash = await bcrypt.hash(teacherPassword, 12);
      const studentHash = await bcrypt.hash(studentPassword, 12);
      const teacherResult = await client.query(
        "INSERT INTO users (username, password_hash, role, elo) VALUES ($1, $2, 'teacher', 1500) RETURNING id",
        [teacherUsername, teacherHash]
      );
      const teacherId = teacherResult.rows[0].id;
      await client.query(
        'INSERT INTO teacher_settings (teacher_id, student_class_elo_visible) VALUES ($1, true)',
        [teacherId]
      );
      await client.query(
        'INSERT INTO demo_instance (singleton, teacher_id, teacher_username, student_username_prefix) VALUES (true, $1, $2, $3)',
        [teacherId, teacherUsername, studentUsername]
      );
      const studentValues = [];
      const studentRows = [];
      for (let index = 1; index <= 5; index++) {
        const username = generatedStudentNames[index - 1];
        studentValues.push(username, studentHash, teacherId);
        const offset = (index - 1) * 3;
        studentRows.push(`($${offset + 1}, $${offset + 2}, 'student', $${offset + 3}, 1500)`);
      }
      const insertedStudents = await client.query(
        `INSERT INTO users (username, password_hash, role, teacher_id, elo) VALUES ${studentRows.join(', ')} RETURNING id, username`,
        studentValues
      );
      const studentIdByUsername = Object.fromEntries(insertedStudents.rows.map((row) => [row.username, row.id]));
      const folderResult = await client.query(
        "INSERT INTO folders (name, created_by) VALUES ('Fictional Preview Catalog', $1) RETURNING id",
        [teacherId]
      );
      const folderId = folderResult.rows[0].id;
      const seededProblemIds = [];
      const seededProblemElos = [];
      for (const problem of DEMO_CATALOG) {
        const validFormats = new Set(['Sprint', 'Target', 'Team', 'Countdown']);
        if (!Array.isArray(problem.formats) || !problem.formats.includes('Sprint')
          || !problem.formats.every((format) => validFormats.has(format))
          || new Set(problem.formats).size !== problem.formats.length
          || !Number.isInteger(problem.difficulty) || problem.difficulty < 1 || problem.difficulty > 5
          || typeof problem.yearBlock !== 'string' || problem.yearBlock.length > 50
          || typeof problem.topic !== 'string' || !problem.topic
          || typeof problem.question !== 'string' || !problem.question
          || typeof problem.answer !== 'string' || !problem.answer) {
          throw new Error('Fictional demo catalog contains an invalid entry');
        }
        const insertedProblem = await client.query(
          `INSERT INTO problems
             (question, answer, topic, source, elo, folder_id, created_by, catalog_formats, difficulty, year_block)
           VALUES ($1, $2, $3, 'Fictional demo catalog', $4, $5, $6, $7, $8, $9)
           RETURNING id, elo`,
          [problem.question, problem.answer, problem.topic, 1100 + (problem.difficulty * 180), folderId, teacherId, problem.formats, problem.difficulty, problem.yearBlock]
        );
        seededProblemIds.push(insertedProblem.rows[0].id);
        seededProblemElos.push(insertedProblem.rows[0].elo);
      }

      const baselineProblemIds = seededProblemIds.slice(0, 8);
      const baselineSnapshot = Object.fromEntries(
        baselineProblemIds.map((problemId, index) => [problemId, seededProblemElos[index]])
      );
      const baselineTest = await client.query(
        `INSERT INTO tests (name, problem_ids, due_date, time_limit, created_by, test_type, problem_elo_snapshot, is_synthetic)
         VALUES ('Synthetic demo history: Target baseline', $1, CURRENT_DATE + 1, 30, $2, 'target', $3::jsonb, true)
         RETURNING id`,
        [baselineProblemIds, teacherId, JSON.stringify(baselineSnapshot)]
      );
      const baselineTestId = baselineTest.rows[0].id;
      const correctnessByStudent = [
        [true, true, true, false, true, true, false, true],
        [true, false, true, true, false, true, true, true],
        [false, true, true, true, true, false, true, false],
        [true, true, false, true, false, true, false, true],
        [false, false, true, false, true, true, true, false],
      ];
      const startingRatings = [1420, 1485, 1550, 1610, 1375];
      const problemUseCounts = Array(baselineProblemIds.length).fill(0);
      const calculateDemoElo = (player, opponent, outcome, kFactor) => {
        const expected = 1 / (1 + Math.pow(10, (opponent - player) / 400));
        return Math.round(player + kFactor * (outcome - expected));
      };

      for (let studentIndex = 0; studentIndex < generatedStudentNames.length; studentIndex++) {
        const studentId = studentIdByUsername[generatedStudentNames[studentIndex]];
        let studentElo = startingRatings[studentIndex];
        await client.query('UPDATE users SET elo = $1 WHERE id = $2', [studentElo, studentId]);
        const eloBefore = studentElo;
        const answers = {};
        const results = {};
        let score = 0;

        for (let problemIndex = 0; problemIndex < baselineProblemIds.length; problemIndex++) {
          const problemId = baselineProblemIds[problemIndex];
          const correct = correctnessByStudent[studentIndex][problemIndex];
          const outcome = correct ? 1 : 0;
          const snapshotElo = baselineSnapshot[problemId];
          const problemDifficultyK = 24 / Math.sqrt(1 + problemUseCounts[problemIndex]);
          const nextStudentElo = calculateDemoElo(
            studentElo,
            snapshotElo,
            outcome,
            32 / Math.sqrt(1 + problemIndex)
          );
          const nextProblemElo = calculateDemoElo(
            snapshotElo,
            studentElo,
            1 - outcome,
            problemDifficultyK
          );
          answers[problemId] = correct ? DEMO_CATALOG[problemIndex].answer : '0';
          results[problemId] = correct;
          if (correct) score++;

          await client.query(
            `INSERT INTO elo_history
               (user_id, problem_id, old_user_elo, new_user_elo, old_problem_elo, new_problem_elo, was_correct, is_synthetic)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
            [studentId, problemId, studentElo, nextStudentElo, snapshotElo, nextProblemElo, correct]
          );
          await client.query(
            `UPDATE problems
             SET elo = $1, times_used = times_used + 1, times_correct = times_correct + $2
             WHERE id = $3`,
            [nextProblemElo, correct ? 1 : 0, problemId]
          );
          problemUseCounts[problemIndex]++;
          studentElo = nextStudentElo;
        }

        await client.query('UPDATE users SET elo = $1 WHERE id = $2', [studentElo, studentId]);
        await client.query(
          `INSERT INTO test_attempts (test_id, student_id, answers, results, score, total, elo_before, elo_after, is_synthetic)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 8, $6, $7, true)`,
          [baselineTestId, studentId, JSON.stringify(answers), JSON.stringify(results), score, eloBefore, studentElo]
        );
      }
      await client.query('COMMIT');
      console.log(`Dedicated fictional preview initialized for teacher ${teacherUsername} with five student accounts and ${DEMO_CATALOG.length} catalog problems.`);
      return;
    }

    // Rights attestation and source references are recorded in
    // backend/PROBLEM_CONTENT_RIGHTS.md. Keep these samples out of the isolated demo DB.
    const licensedNationalSprintSamples = [
      {
        number: 1,
        question: 'No matter where Sasha is in the country, the pre-tax price of a cup of coffee at a particular coffee retailer is always $4.00. However, sales tax varies by region. In Atlanta there is a 7.5% sales tax, while in Chicago there is a 10.25% sales tax. How many cents more does Sasha pay when she buys the coffee in Chicago than when she buys it in Atlanta?',
        answer: '11',
      },
      {
        number: 2,
        question: 'Hans is staying at a hotel that has five floors, numbered 1 through 5, and 10 rooms per floor, numbered 1 through 10. Hans forgets where his room is, but knows that it is on an even numbered floor and the room number is divisible by 4. If Hans randomly chooses a room he knows might be his room, what is the probability that Hans chooses the correct room? Express your answer as a common fraction.',
        answer: '1/4',
      },
      {
        number: 3,
        question: 'If an inchworm travels 1 inch every 2 seconds, how many feet will it travel in 1 hour?',
        answer: '150',
      },
      {
        number: 4,
        question: 'If the five-digit number 46A81 is divisible by 9, what digit does A represent?',
        answer: '8',
      },
      {
        number: 5,
        question: 'Leonardo has a cylindrical box of height 10 cm and radius 15 cm. He paints the top and bottom circular faces of his box green, and the lateral surface red. What is the ratio of green-painted area to red-painted area on his box?',
        answer: '3/2',
      },
    ];
    await client.query('BEGIN');
    try {
      // Serialize this idempotent seed across service instances during deploys.
      await client.query('SELECT pg_advisory_xact_lock(20221105)');
      for (const sample of licensedNationalSprintSamples) {
        const source = `2022 MATHCOUNTS National Competition, Sprint Round, Problem ${sample.number}`;
        await client.query(
          `INSERT INTO problems (question, answer, topic, source, created_by, year, level, round, problem_number)
           SELECT $1, $2, '', $3, NULL, 2022, 'Nationals', 'Sprint', $4
           WHERE NOT EXISTS (
             SELECT 1 FROM problems WHERE source = $3
           )`,
          [sample.question, sample.answer, source, sample.number]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

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
    
    // Create default tags if empty
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
