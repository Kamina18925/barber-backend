import bcrypt from 'bcrypt';
import pool from '../db/connection.js';

const getArgValue = (name) => {
  const idx = process.argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return undefined;
  const raw = process.argv[idx];
  if (raw.includes('=')) return raw.split('=').slice(1).join('=');
  return process.argv[idx + 1];
};

const hasFlag = (name) => process.argv.includes(name);

const getPositional = (index) => {
  const value = process.argv[index];
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : undefined;
};

const quoteIdent = (value) => {
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
};

const main = async () => {
  const applyFlag = hasFlag('--apply') || hasFlag('--force');
  const confirmFlag = String(getArgValue('--confirm') || '').trim();

  const adminEmailFlag = getArgValue('--admin-email');
  const adminPasswordFlag = getArgValue('--admin-password');
  const adminNameFlag = getArgValue('--admin-name');

  const confirmPos = getPositional(2);
  const adminEmailPos = getPositional(3);
  const adminPasswordPos = getPositional(4);
  const adminNamePos = getPositional(5);

  const confirm = confirmFlag || confirmPos || '';
  const apply = applyFlag || confirm === 'DELETE_ALL_DATA';

  const adminEmail = adminEmailFlag || adminEmailPos;
  const adminPassword = adminPasswordFlag || adminPasswordPos;
  const adminName = adminNameFlag || adminNamePos;

  const shouldRun = apply && String(confirm).trim() === 'DELETE_ALL_DATA';

  const client = await pool.connect();
  try {
    const tablesRes = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    const tables = (tablesRes.rows || []).map((r) => r.tablename).filter(Boolean);

    if (!tables.includes('users')) {
      throw new Error('No se encontró la tabla users en el schema public.');
    }

    const tablesToTruncate = tables
      .filter((t) => t !== 'users')
      .filter((t) => t !== 'spatial_ref_sys');

    const adminRes = await client.query(
      "SELECT id, email, role FROM users WHERE LOWER(role) LIKE '%admin%' ORDER BY id ASC"
    );
    const admins = adminRes.rows || [];

    if (!shouldRun) {
      console.log('[reset-db] DRY RUN (no changes).');
      console.log('[reset-db] Tables to truncate:', tablesToTruncate);
      console.log('[reset-db] Admin users found:', admins);
      console.log(
        '[reset-db] To apply, run with: --apply --confirm DELETE_ALL_DATA ' +
          '[--admin-email ... --admin-password ... --admin-name ...]'
      );
      return;
    }

    await client.query('BEGIN');

    if (tablesToTruncate.length) {
      const stmt = `TRUNCATE TABLE ${tablesToTruncate
        .map((t) => quoteIdent(t))
        .join(', ')} RESTART IDENTITY CASCADE`;
      await client.query(stmt);
    }

    const adminAfterRes = await client.query(
      "SELECT id, email, role FROM users WHERE LOWER(role) LIKE '%admin%' ORDER BY id ASC"
    );
    let adminAfter = (adminAfterRes.rows || [])[0];

    if (!adminAfter) {
      const email = String(adminEmail || 'admin@stylex.app').trim().toLowerCase();
      const pwdRaw = String(adminPassword || 'Admin123!');
      const name = String(adminName || 'Administrador');

      const hashed = await bcrypt.hash(pwdRaw, 10);
      const created = await client.query(
        `INSERT INTO users (name, email, password, role, created_at, updated_at)
         VALUES ($1, $2, $3, 'admin', NOW(), NOW())
         RETURNING id, email, role`,
        [name, email, hashed]
      );
      adminAfter = created.rows[0];
    }

    await client.query(
      "DELETE FROM users WHERE LOWER(role) NOT LIKE '%admin%'"
    );

    await client.query(
      "DELETE FROM users WHERE id <> $1 AND LOWER(role) LIKE '%admin%'",
      [adminAfter.id]
    );

    if (adminEmail || adminPassword || adminName) {
      const email = adminEmail != null ? String(adminEmail).trim().toLowerCase() : null;
      const name = adminName != null ? String(adminName).trim() : null;
      const pwdRaw = adminPassword != null ? String(adminPassword) : null;

      const hashed = pwdRaw != null ? await bcrypt.hash(pwdRaw, 10) : null;

      await client.query(
        `UPDATE users
         SET name = COALESCE($2, name),
             email = COALESCE($3, email),
             password = COALESCE($4, password),
             deleted_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [adminAfter.id, name, email, hashed]
      );
    } else {
      await client.query(
        'UPDATE users SET deleted_at = NULL, updated_at = NOW() WHERE id = $1',
        [adminAfter.id]
      );
    }

    try {
      await client.query(
        "SELECT setval(pg_get_serial_sequence('users','id'), (SELECT COALESCE(MAX(id), 1) FROM users), true)"
      );
    } catch {
    }

    await client.query('COMMIT');

    const finalAdmin = await client.query(
      "SELECT id, name, email, role FROM users ORDER BY id ASC"
    );
    console.log('[reset-db] Done. Remaining users:', finalAdmin.rows);
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
    }
    console.error('[reset-db] Failed:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => null);
  }
};

main();
