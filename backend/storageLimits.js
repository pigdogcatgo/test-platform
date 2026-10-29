export const TEACHER_UPLOAD_QUOTA_BYTES = 50 * 1024 * 1024;
export const GLOBAL_UPLOAD_QUOTA_BYTES = 200 * 1024 * 1024;
const ORPHAN_UPLOAD_GRACE = "24 hours";
const UPLOAD_QUOTA_LOCK_NAMESPACE = 734221;

// Commit stale-row collection independently so a later quota rejection cannot
// roll the cleanup back with the upload/import transaction.
export async function cleanupStaleUnreferencedUploads(pool) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [UPLOAD_QUOTA_LOCK_NAMESPACE, 0]);
    await client.query(
      `DELETE FROM uploads u
       WHERE u.created_at < NOW() - INTERVAL '${ORPHAN_UPLOAD_GRACE}'
         AND NOT EXISTS (SELECT 1 FROM problems p WHERE p.image_url = '/uploads/db/' || u.id::text)`
    );
    await client.query('COMMIT');
  } catch (cause) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    const error = new Error('Image storage cleanup is temporarily unavailable');
    error.status = 503;
    error.cause = cause;
    throw error;
  } finally {
    client?.release();
  }
}

function imageUploadIdFromUrl(url) {
  const match = typeof url === 'string' && url.match(/^\/uploads\/db\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

// Delete only uploads no saved problem references. Call inside a transaction;
// quota inserts take the same per-teacher advisory lock.
export async function deleteUnreferencedImageUploads(client, imageUrls, createdBy = null) {
  const ids = [...new Set((imageUrls || []).map(imageUploadIdFromUrl).filter(Number.isSafeInteger))];
  if (!ids.length) return 0;
  await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [UPLOAD_QUOTA_LOCK_NAMESPACE, 0]);
  if (createdBy != null) {
    await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [UPLOAD_QUOTA_LOCK_NAMESPACE, createdBy]);
  }
  const result = await client.query(
    `DELETE FROM uploads u
     WHERE u.id = ANY($1::integer[])
       AND ($2::integer IS NULL OR u.created_by = $2)
       AND NOT EXISTS (SELECT 1 FROM problems p WHERE p.image_url = '/uploads/db/' || u.id::text)`,
    [ids, createdBy]
  );
  return result.rowCount;
}

// Call inside a transaction. The advisory lock serializes concurrent quota
// checks for the same teacher until the upload transaction commits or rolls back.
export async function insertImageUpload(client, { data, filename, contentType, createdBy }) {
  await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [UPLOAD_QUOTA_LOCK_NAMESPACE, 0]);
  if (createdBy != null) {
    await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [UPLOAD_QUOTA_LOCK_NAMESPACE, createdBy]);
  }

  // A platform-wide cap keeps public teacher signup from multiplying the
  // per-teacher allowance until the free database runs out of room.
  const platformStored = await client.query(
    `SELECT COALESCE(SUM(octet_length(u.data)), 0)::bigint AS bytes
     FROM uploads u
     WHERE u.created_at >= NOW() - INTERVAL '${ORPHAN_UPLOAD_GRACE}'
        OR EXISTS (SELECT 1 FROM problems p WHERE p.image_url = '/uploads/db/' || u.id::text)`
  );
  const platformUsedBytes = BigInt(platformStored.rows[0].bytes);
  const incomingBytes = BigInt(Buffer.byteLength(data, 'utf8'));
  if (platformUsedBytes + incomingBytes > BigInt(GLOBAL_UPLOAD_QUOTA_BYTES)) {
    const error = new Error('Platform image storage limit reached (200 MB)');
    error.status = 413;
    throw error;
  }

  if (createdBy != null) {
    const stored = await client.query(
      `SELECT COALESCE(SUM(octet_length(u.data)), 0)::bigint AS bytes
       FROM uploads u
       WHERE u.created_by = $1
         AND (u.created_at >= NOW() - INTERVAL '${ORPHAN_UPLOAD_GRACE}'
              OR EXISTS (SELECT 1 FROM problems p WHERE p.image_url = '/uploads/db/' || u.id::text))`,
      [createdBy]
    );
    const usedBytes = BigInt(stored.rows[0].bytes);
    if (usedBytes + incomingBytes > BigInt(TEACHER_UPLOAD_QUOTA_BYTES)) {
      const error = new Error('Teacher image storage limit reached (50 MB)');
      error.status = 413;
      throw error;
    }
  }

  return client.query(
    'INSERT INTO uploads (data, filename, content_type, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [data, filename, contentType, createdBy]
  );
}
