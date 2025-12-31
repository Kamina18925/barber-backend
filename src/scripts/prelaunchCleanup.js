import dotenv from 'dotenv';
import pool from '../db/connection.js';

dotenv.config();

const parseArgs = (argv) => {
  const args = new Set(argv);
  const getValue = (name) => {
    const idx = argv.indexOf(name);
    if (idx === -1) return null;
    const next = argv[idx + 1];
    if (!next || next.startsWith('--')) return null;
    return next;
  };

  return {
    apply: args.has('--apply'),
    dryRun: args.has('--dry-run') || !args.has('--apply'),
    deleteDemoUsers: args.has('--delete-demo-users'),
    demoEmailDomain: getValue('--demo-email-domain') || 'example.com',
  };
};

const toBool = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
};

const hasColumn = async (client, tableName, columnName) => {
  const res = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return res.rows.length > 0;
};

const countQuery = async (client, sql, params = []) => {
  const res = await client.query(sql, params);
  const n = Number(res.rows?.[0]?.count || 0);
  return Number.isFinite(n) ? n : 0;
};

const safeExec = async (client, sql, params = []) => {
  try {
    return await client.query(sql, params);
  } catch (e) {
    if (e && e.code === '42P01') {
      return { rowCount: 0, rows: [] };
    }
    throw e;
  }
};

const runUpdateStep = async (client, { label, countSql, countParams, applySql, applyParams }) => {
  const before = await countQuery(client, countSql, countParams);
  console.log(`- ${label}: ${before}`);
  if (before === 0) return { label, affected: 0 };

  if (!applySql) return { label, affected: before };

  const res = await client.query(applySql, applyParams);
  const affected = Number(res.rowCount || 0);
  return { label, affected: Number.isFinite(affected) ? affected : 0 };
};

const run = async () => {
  const opts = parseArgs(process.argv.slice(2));
  console.log('[prelaunchCleanup] options:', {
    apply: opts.apply,
    dryRun: opts.dryRun,
    deleteDemoUsers: opts.deleteDemoUsers,
    demoEmailDomain: opts.demoEmailDomain,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const hasUsersDeletedAt = await hasColumn(client, 'users', 'deleted_at');
    const hasShopsDeletedAt = await hasColumn(client, 'barber_shops', 'deleted_at');

    const steps = [];

    // --- Orphan cleanup: appointments
    steps.push(
      await runUpdateStep(client, {
        label: 'appointments.client_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM appointments a
                  WHERE a.client_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = a.client_id::text)`,
        applySql: opts.apply
          ? `UPDATE appointments a
             SET client_id = NULL,
                 updated_at = NOW()
             WHERE a.client_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = a.client_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'appointments.barber_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM appointments a
                  WHERE a.barber_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = a.barber_id::text)`,
        applySql: opts.apply
          ? `UPDATE appointments a
             SET barber_id = NULL,
                 updated_at = NOW()
             WHERE a.barber_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = a.barber_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'appointments.shop_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM appointments a
                  WHERE a.shop_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM barber_shops bs WHERE bs.id::text = a.shop_id::text)`,
        applySql: opts.apply
          ? `UPDATE appointments a
             SET shop_id = NULL,
                 updated_at = NOW()
             WHERE a.shop_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM barber_shops bs WHERE bs.id::text = a.shop_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'appointments.service_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM appointments a
                  WHERE a.service_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM services s WHERE s.id::text = a.service_id::text)`,
        applySql: opts.apply
          ? `UPDATE appointments a
             SET service_id = NULL,
                 updated_at = NOW()
             WHERE a.service_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM services s WHERE s.id::text = a.service_id::text)`
          : null,
      })
    );

    // --- Orphan cleanup: services/products
    steps.push(
      await runUpdateStep(client, {
        label: 'services.shop_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM services s
                  WHERE s.shop_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM barber_shops bs WHERE bs.id::text = s.shop_id::text)`,
        applySql: opts.apply
          ? `UPDATE services s
             SET shop_id = NULL,
                 updated_at = NOW()
             WHERE s.shop_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM barber_shops bs WHERE bs.id::text = s.shop_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'products.shop_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM products p
                  WHERE p.shop_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM barber_shops bs WHERE bs.id::text = p.shop_id::text)`,
        applySql: opts.apply
          ? `UPDATE products p
             SET shop_id = NULL,
                 updated_at = NOW()
             WHERE p.shop_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM barber_shops bs WHERE bs.id::text = p.shop_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'products.barber_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM products p
                  WHERE p.barber_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = p.barber_id::text)`,
        applySql: opts.apply
          ? `UPDATE products p
             SET barber_id = NULL,
                 updated_at = NOW()
             WHERE p.barber_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = p.barber_id::text)`
          : null,
      })
    );

    // --- Orphan cleanup: reviews
    steps.push(
      await runUpdateStep(client, {
        label: 'reviews.user_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM reviews r
                  WHERE r.user_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = r.user_id::text)`,
        applySql: opts.apply
          ? `UPDATE reviews r
             SET user_id = NULL,
                 updated_at = NOW()
             WHERE r.user_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = r.user_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'reviews.shop_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM reviews r
                  WHERE r.shop_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM barber_shops bs WHERE bs.id::text = r.shop_id::text)`,
        applySql: opts.apply
          ? `UPDATE reviews r
             SET shop_id = NULL,
                 updated_at = NOW()
             WHERE r.shop_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM barber_shops bs WHERE bs.id::text = r.shop_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'reviews.appointment_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM reviews r
                  WHERE r.appointment_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id::text = r.appointment_id::text)`,
        applySql: opts.apply
          ? `UPDATE reviews r
             SET appointment_id = NULL,
                 updated_at = NOW()
             WHERE r.appointment_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id::text = r.appointment_id::text)`
          : null,
      })
    );

    // --- Orphan cleanup: chat
    steps.push(
      await runUpdateStep(client, {
        label: 'conversations.appointment_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM conversations c
                  WHERE c.appointment_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id::text = c.appointment_id::text)`,
        applySql: opts.apply
          ? `UPDATE conversations c
             SET appointment_id = NULL,
                 updated_at = NOW()
             WHERE c.appointment_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id::text = c.appointment_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'conversations.client_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM conversations c
                  WHERE c.client_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = c.client_id::text)`,
        applySql: opts.apply
          ? `UPDATE conversations c
             SET client_id = NULL,
                 updated_at = NOW()
             WHERE c.client_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = c.client_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'conversations.barber_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM conversations c
                  WHERE c.barber_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = c.barber_id::text)`,
        applySql: opts.apply
          ? `UPDATE conversations c
             SET barber_id = NULL,
                 updated_at = NOW()
             WHERE c.barber_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = c.barber_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'conversations.owner_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM conversations c
                  WHERE c.owner_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = c.owner_id::text)`,
        applySql: opts.apply
          ? `UPDATE conversations c
             SET owner_id = NULL,
                 updated_at = NOW()
             WHERE c.owner_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = c.owner_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'messages.sender_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM messages m
                  WHERE m.sender_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = m.sender_id::text)`,
        applySql: opts.apply
          ? `UPDATE messages m
             SET sender_id = NULL
             WHERE m.sender_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = m.sender_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'messages.receiver_id huérfanos -> NULL',
        countSql: `SELECT COUNT(*)::int as count
                  FROM messages m
                  WHERE m.receiver_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = m.receiver_id::text)`,
        applySql: opts.apply
          ? `UPDATE messages m
             SET receiver_id = NULL
             WHERE m.receiver_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = m.receiver_id::text)`
          : null,
      })
    );

    // --- Orphan cleanup: tables that should never have orphans (delete rows)
    steps.push(
      await runUpdateStep(client, {
        label: 'barber_services huérfanos -> DELETE',
        countSql: `SELECT COUNT(*)::int as count
                  FROM barber_services bs
                  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = bs.barber_id::text)
                     OR NOT EXISTS (SELECT 1 FROM services s WHERE s.id::text = bs.service_id::text)`,
        applySql: opts.apply
          ? `DELETE FROM barber_services bs
             WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = bs.barber_id::text)
                OR NOT EXISTS (SELECT 1 FROM services s WHERE s.id::text = bs.service_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'barber_availability huérfanos -> DELETE',
        countSql: `SELECT COUNT(*)::int as count
                  FROM barber_availability ba
                  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = ba.barber_id::text)`,
        applySql: opts.apply
          ? `DELETE FROM barber_availability ba
             WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = ba.barber_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'barber_breaks huérfanos -> DELETE',
        countSql: `SELECT COUNT(*)::int as count
                  FROM barber_breaks bb
                  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = bb.barber_id::text)`,
        applySql: opts.apply
          ? `DELETE FROM barber_breaks bb
             WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = bb.barber_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'subscriptions huérfanos -> DELETE',
        countSql: `SELECT COUNT(*)::int as count
                  FROM subscriptions s
                  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = s.owner_id::text)`,
        applySql: opts.apply
          ? `DELETE FROM subscriptions s
             WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = s.owner_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'payments huérfanos -> DELETE',
        countSql: `SELECT COUNT(*)::int as count
                  FROM payments p
                  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = p.owner_id::text)`,
        applySql: opts.apply
          ? `DELETE FROM payments p
             WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = p.owner_id::text)`
          : null,
      })
    );

    steps.push(
      await runUpdateStep(client, {
        label: 'manual_payment_reports huérfanos -> DELETE',
        countSql: `SELECT COUNT(*)::int as count
                  FROM manual_payment_reports r
                  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = r.owner_id::text)`,
        applySql: opts.apply
          ? `DELETE FROM manual_payment_reports r
             WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = r.owner_id::text)`
          : null,
      })
    );

    // --- Orphan shops: owner_id points to missing user
    {
      const orphanShopCount = await countQuery(
        client,
        `SELECT COUNT(*)::int as count
         FROM barber_shops bs
         WHERE bs.owner_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = bs.owner_id::text)`
      );
      console.log(`- barber_shops con owner_id huérfano: ${orphanShopCount}`);

      if (orphanShopCount > 0 && opts.apply) {
        const setDeletedAt = hasShopsDeletedAt
          ? `, deleted_at = COALESCE(deleted_at, NOW())`
          : '';

        await client.query(
          `UPDATE users u
           SET shop_id = NULL
           WHERE u.shop_id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM barber_shops bs
               WHERE bs.id::text = u.shop_id::text
                 AND bs.owner_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.id::text = bs.owner_id::text)
             )`
        );

        await client.query(
          `UPDATE services s
           SET shop_id = NULL,
               updated_at = NOW()
           WHERE s.shop_id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM barber_shops bs
               WHERE bs.id::text = s.shop_id::text
                 AND bs.owner_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.id::text = bs.owner_id::text)
             )`
        );

        await client.query(
          `UPDATE products p
           SET shop_id = NULL,
               updated_at = NOW()
           WHERE p.shop_id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM barber_shops bs
               WHERE bs.id::text = p.shop_id::text
                 AND bs.owner_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.id::text = bs.owner_id::text)
             )`
        );

        await client.query(
          `UPDATE appointments a
           SET shop_id = NULL,
               updated_at = NOW()
           WHERE a.shop_id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM barber_shops bs
               WHERE bs.id::text = a.shop_id::text
                 AND bs.owner_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.id::text = bs.owner_id::text)
             )`
        );

        await client.query(
          `UPDATE barber_shops bs
           SET owner_id = NULL,
               updated_at = NOW()
               ${setDeletedAt}
           WHERE bs.owner_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = bs.owner_id::text)`
        );
      }
    }

    // --- Demo user deletion (optional)
    {
      const domain = String(opts.demoEmailDomain || '').trim().toLowerCase();
      const pattern = `%@${domain}`;

      const demoUsersCount = await countQuery(
        client,
        `SELECT COUNT(*)::int as count
         FROM users u
         WHERE u.email ILIKE $1
           AND LOWER(COALESCE(u.role, '')) NOT LIKE '%admin%'`,
        [pattern]
      );

      console.log(`- users demo (email ILIKE ${pattern}, excluding admin): ${demoUsersCount}`);

      if (demoUsersCount > 0) {
        const rolesRes = await client.query(
          `SELECT LOWER(COALESCE(role, '')) as role, COUNT(*)::int as count
           FROM users
           WHERE email ILIKE $1
             AND LOWER(COALESCE(role, '')) NOT LIKE '%admin%'
           GROUP BY LOWER(COALESCE(role, ''))
           ORDER BY count DESC`,
          [pattern]
        );

        console.log('  roles demo:', rolesRes.rows);
      }

      if (demoUsersCount > 0 && opts.apply && opts.deleteDemoUsers) {
        const demoIdsRes = await safeExec(
          client,
          `SELECT id::text as id
           FROM users
           WHERE email ILIKE $1
             AND LOWER(COALESCE(role, '')) NOT LIKE '%admin%'`,
          [pattern]
        );
        const demoIds = (demoIdsRes.rows || []).map(r => String(r.id)).filter(Boolean);

        if (demoIds.length > 0) {
          await safeExec(
            client,
            `UPDATE appointments
             SET client_id = NULL,
                 updated_at = NOW()
             WHERE client_id IS NOT NULL
               AND client_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE appointments
             SET barber_id = NULL,
                 updated_at = NOW()
             WHERE barber_id IS NOT NULL
               AND barber_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE reviews
             SET user_id = NULL,
                 updated_at = NOW()
             WHERE user_id IS NOT NULL
               AND user_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE conversations
             SET client_id = NULL,
                 updated_at = NOW()
             WHERE client_id IS NOT NULL
               AND client_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE conversations
             SET barber_id = NULL,
                 updated_at = NOW()
             WHERE barber_id IS NOT NULL
               AND barber_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE conversations
             SET owner_id = NULL,
                 updated_at = NOW()
             WHERE owner_id IS NOT NULL
               AND owner_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE messages
             SET sender_id = NULL
             WHERE sender_id IS NOT NULL
               AND sender_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE messages
             SET receiver_id = NULL
             WHERE receiver_id IS NOT NULL
               AND receiver_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE products
             SET barber_id = NULL,
                 updated_at = NOW()
             WHERE barber_id IS NOT NULL
               AND barber_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE barber_shops
             SET owner_id = NULL,
                 updated_at = NOW()
             WHERE owner_id IS NOT NULL
               AND owner_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `UPDATE users
             SET shop_id = NULL
             WHERE shop_id IS NOT NULL
               AND shop_id::text IN (
                 SELECT bs.id::text
                 FROM barber_shops bs
                 WHERE bs.owner_id IS NOT NULL
                   AND bs.owner_id::text = ANY($1::text[])
               )`,
            [demoIds]
          );

          await safeExec(
            client,
            `DELETE FROM barber_services
             WHERE barber_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `DELETE FROM barber_availability
             WHERE barber_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `DELETE FROM barber_breaks
             WHERE barber_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `DELETE FROM manual_payment_reports
             WHERE owner_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `DELETE FROM payments
             WHERE owner_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `DELETE FROM subscriptions
             WHERE owner_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `DELETE FROM sessions
             WHERE user_id::text = ANY($1::text[])`,
            [demoIds]
          );

          await safeExec(
            client,
            `DELETE FROM notifications
             WHERE user_id::text = ANY($1::text[])`,
            [demoIds]
          );
        }

        if (hasUsersDeletedAt && toBool(process.env.PRELAUNCH_SOFT_DELETE_USERS)) {
          await safeExec(
            client,
            `UPDATE users
             SET deleted_at = COALESCE(deleted_at, NOW())
             WHERE email ILIKE $1
               AND LOWER(COALESCE(role, '')) NOT LIKE '%admin%'`,
            [pattern]
          );
        } else {
          await safeExec(
            client,
            `DELETE FROM users
             WHERE email ILIKE $1
               AND LOWER(COALESCE(role, '')) NOT LIKE '%admin%'`,
            [pattern]
          );
        }
      }
    }

    if (opts.apply) {
      await client.query('COMMIT');
      console.log('[prelaunchCleanup] APPLY complete.');
    } else {
      await client.query('ROLLBACK');
      console.log('[prelaunchCleanup] DRY-RUN complete (rolled back).');
    }

    const totalAffected = steps.reduce((acc, s) => acc + (Number(s?.affected || 0) || 0), 0);
    console.log(`[prelaunchCleanup] summary: ${totalAffected} rows would be affected by listed steps.`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
    }
    console.error('[prelaunchCleanup] FAILED:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    try {
      await pool.end();
    } catch {
    }
  }
};

void run();
