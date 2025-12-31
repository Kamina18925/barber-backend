import pool from '../db/connection.js';
import bcrypt from 'bcrypt';
import { enforceOwnerSubscriptionForManagement, enforceShopSubscriptionForBooking } from '../services/subscriptionService.js';
import jwt from 'jsonwebtoken';

const normalizeRole = (role) => String(role || '').toLowerCase();

const canAccessUser = (req, targetUserId) => {
  const role = normalizeRole(req.user?.role);
  if (role.includes('admin')) return true;
  const uid = req.user?.userId;
  return uid != null && String(uid) === String(targetUserId);
};

const requireSelfOrAdmin = (req, res, targetUserId) => {
  if (!req.user?.userId) {
    res.status(401).json({ message: 'Authentication required' });
    return false;
  }
  if (!canAccessUser(req, targetUserId)) {
    res.status(403).json({ message: 'Acceso denegado' });
    return false;
  }
  return true;
};

const getAdminFromOptionalJwt = (req) => {
  const authHeader = req.headers?.authorization;
  const token = authHeader && String(authHeader).startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const role = normalizeRole(decoded?.role);
    if (role.includes('admin')) return decoded;
    return null;
  } catch {
    return null;
  }
};

export const getVisibleUsers = async (req, res) => {
  try {
    const requesterId = req.user?.userId;
    const role = normalizeRole(req.user?.role);
    if (!requesterId) return res.status(401).json({ message: 'Authentication required' });

    if (role.includes('admin')) {
      return await getAllUsers(req, res);
    }

    if (role.includes('owner')) {
      const result = await queryWithRetry(
        `SELECT DISTINCT
           u.id,
           u.name as nombre,
           u.email,
           u.phone as telefono,
           u.role,
           u.can_delete_history,
           u.shop_id,
           u.photo_url,
           u.whatsapp_link,
           u.gender,
           u.deleted_at
         FROM users u
         LEFT JOIN barber_shops bs ON bs.id = u.shop_id
         WHERE u.deleted_at IS NULL
           AND (
             u.id = $1
             OR (u.role ILIKE '%barber%' AND bs.owner_id = $1 AND bs.deleted_at IS NULL)
             OR (u.role ILIKE '%barber%' AND u.shop_id IS NULL)
           )
         ORDER BY u.name`,
        [requesterId],
        USERS_QUERY_TIMEOUT_MS
      );
      return res.json(result.rows);
    }

    const selfRes = await queryWithRetry(
      `SELECT id, name as nombre, email, phone as telefono, role, whatsapp_link, photo_url, gender, shop_id
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [requesterId],
      USERS_QUERY_TIMEOUT_MS
    );
    return res.json(selfRes.rows);
  } catch (error) {
    console.error('Error getVisibleUsers:', error);
    return res.status(500).json({ message: 'Error del servidor al obtener usuarios' });
  }
};

export const getCurrentUserProfile = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Authentication required' });

    const result = await queryWithRetry(
      `SELECT id, uuid, name, email, phone, role, shop_id, photo_url, whatsapp_link, gender
       FROM users
       WHERE id = $1`,
      [userId],
      USERS_QUERY_TIMEOUT_MS
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Error getCurrentUserProfile:', error);
    return res.status(500).json({ message: 'Error del servidor al obtener usuario' });
  }
};

// Función helper para registrar operaciones de BD exitosas
const logDbSuccess = (operation, details = '') => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ✅ DB OPERACIÓN EXITOSA: ${operation} ${details ? '- ' + details : ''}`);
};

export const deleteOwnerAccount = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    if (!requireSelfOrAdmin(req, res, id)) return;
    const {
      currentPassword,
      contrasenaActual,
      confirmText,
      confirm_text
    } = req.body || {};

    const currentPwd = currentPassword || contrasenaActual;
    const rawConfirm = (confirmText !== undefined ? confirmText : confirm_text);
    const normalizedConfirm = String(rawConfirm || '').trim().toLowerCase().replace(/\s+/g, ' ');

    if (!currentPwd) {
      return res.status(400).json({ message: 'Debes ingresar tu contraseña actual.' });
    }

    if (normalizedConfirm !== 'eliminar mi cuenta') {
      return res.status(400).json({ message: 'Debes escribir "eliminar mi cuenta" para confirmar.' });
    }

    await client.query('BEGIN');

    const existingResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const existing = existingResult.rows[0];
    const roleStr = String(existing.role || '').toLowerCase();
    if (!roleStr.includes('owner')) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Solo los dueños pueden eliminar su cuenta desde aquí.' });
    }

    const ok = await bcrypt.compare(currentPwd, existing.password);
    if (!ok) {
      await client.query('ROLLBACK');
      return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    }

    const shopsRes = await client.query('SELECT id FROM barber_shops WHERE owner_id = $1', [id]);
    const shopIds = (shopsRes.rows || []).map(r => r.id).filter(v => v != null);

    for (const shopId of shopIds) {
      await client.query('UPDATE users SET shop_id = NULL WHERE shop_id = $1', [shopId]);

      // Archivar negocios del dueño (soft delete)
      await client.query(
        'UPDATE barber_shops SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
        [shopId]
      );
    }

    // Revocar sesiones
    await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);

    // Marcar usuario como eliminado + anonimizar para liberar email único
    const anonymizedEmail = `deleted+${id}@stylex.invalid`;
    await client.query(
      `UPDATE users
       SET deleted_at = NOW(),
           email = $2,
           name = COALESCE(NULLIF(name, ''), 'Usuario eliminado'),
           phone = NULL,
           whatsapp_link = NULL,
           photo_url = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id, anonymizedEmail]
    );

    await client.query('COMMIT');
    res.status(204).send();
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
    }
    console.error('Error al eliminar cuenta de dueño:', error);
    res.status(500).json({ message: 'Error del servidor al eliminar cuenta' });
  } finally {
    client.release();
  }
};

const isTransientConnectionError = (error) => {
  const msg = String(error?.message || '');
  const code = String(error?.code || '');
  return (
    msg.includes('Connection terminated unexpectedly') ||
    msg.includes('terminating connection') ||
    msg.includes('ECONNRESET') ||
    msg.includes('Query read timeout') ||
    msg.includes('timeout') ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03'
  );
};

const queryWithRetry = async (text, params, queryTimeoutMs) => {
  const delaysMs = [0, 250];
  let lastError;

  for (const delay of delaysMs) {
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    let client;
    try {
      client = await Promise.race([
        pool.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('connect_timeout')), 2500)),
      ]);
    } catch (error) {
      lastError = error;
      if (!isTransientConnectionError(error)) throw error;
      continue;
    }
    try {
      return await client.query({
        text,
        values: params,
        ...(queryTimeoutMs != null ? { query_timeout: queryTimeoutMs } : {}),
      });
    } catch (error) {
      lastError = error;
      if (!isTransientConnectionError(error)) throw error;
    } finally {
      try {
        client.release();
      } catch {
      }
    }
  }

  throw lastError;
};

let __usersCache = null;
let __usersCacheAtMs = 0;
const USERS_CACHE_TTL_MS = 60000;
const USERS_QUERY_TIMEOUT_MS = 2500;

// Obtener todos los usuarios
export const getAllUsers = async (req, res) => {
  try {
    const includeDeleted = String(req.query?.includeDeleted ?? req.query?.include_deleted ?? '').toLowerCase() === 'true';
    const nowMs = Date.now();
    if (!includeDeleted && Array.isArray(__usersCache) && nowMs - __usersCacheAtMs < USERS_CACHE_TTL_MS) {
      return res.json(__usersCache);
    }

    const result = await queryWithRetry(
      `
        SELECT 
          id,
          name as nombre,
          email,
          phone as telefono,
          role,
          can_delete_history,
          shop_id,
          photo_url,
          whatsapp_link,
          gender,
          deleted_at
        FROM users
        ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
        ORDER BY name
      `,
      [],
      USERS_QUERY_TIMEOUT_MS
    );

    logDbSuccess('SELECT', `Obtenidos ${result.rows.length} usuarios correctamente`);

    if (!includeDeleted) {
      __usersCache = result.rows;
      __usersCacheAtMs = Date.now();
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener usuarios:', error);
    if (Array.isArray(__usersCache) && __usersCache.length > 0) {
      return res.json(__usersCache);
    }
    // Evitar que el frontend quede colgado por timeouts cuando la BD está intermitente.
    // El polling reintentará y llenará el estado cuando el pooler se estabilice.
    return res.json([]);
  }
};

// Obtener usuario por ID
export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!requireSelfOrAdmin(req, res, id)) return;
    
    const result = await queryWithRetry(`
      SELECT id, name as nombre, email, phone as telefono, role, whatsapp_link, photo_url, gender
      FROM users
      WHERE id = $1
    `, [id], USERS_QUERY_TIMEOUT_MS);
    
    logDbSuccess('SELECT', `Consulta de usuario con ID=${id} completada`);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    
    logDbSuccess('SELECT', `Usuario con ID=${id} encontrado y recuperado: ${result.rows[0].nombre}`);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener usuario por ID:', error);
    res.status(500).json({ message: 'Error del servidor al obtener usuario' });
  }
};

export const updateUserProfile = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    if (!requireSelfOrAdmin(req, res, id)) return;
    const {
      nombre,
      name,
      email,
      correo,
      telefono,
      phone,
      photoUrl,
      photo_url,
      currentPassword,
      contrasenaActual
    } = req.body || {};

    const currentPwd = currentPassword || contrasenaActual;

    if (!currentPwd) {
      return res.status(400).json({ message: 'Debes ingresar tu contraseña actual para guardar cambios.' });
    }

    await client.query('BEGIN');

    const existingResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const existing = existingResult.rows[0];
    const ok = await bcrypt.compare(currentPwd, existing.password);
    if (!ok) {
      await client.query('ROLLBACK');
      return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    }

    const finalName = (nombre || name || existing.name || '').trim();
    const finalPhone = (telefono || phone || existing.phone || '').trim();
    const incomingEmail = (email !== undefined ? email : correo);
    const nextEmail = incomingEmail == null ? null : String(incomingEmail || '').trim();

    if (nextEmail && nextEmail.toLowerCase() !== String(existing.email || '').trim().toLowerCase()) {
      const emailCheck = await client.query(
        'SELECT 1 FROM users WHERE email = $1 AND id != $2',
        [nextEmail, id]
      );
      if (emailCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'El email ya está registrado por otro usuario' });
      }
    }

    const nextPhotoUrl = (photoUrl !== undefined || photo_url !== undefined)
      ? (photoUrl || photo_url || null)
      : existing.photo_url;

    const roleStr = String(existing.role || '').toLowerCase();

    const currentEmailNorm = String(existing.email || '').trim().toLowerCase();
    const nextEmailNorm = nextEmail ? String(nextEmail || '').trim().toLowerCase() : '';
    const isOwnerChangingEmail = roleStr.includes('owner') && Boolean(nextEmail) && nextEmailNorm !== currentEmailNorm;
    if (isOwnerChangingEmail) {
      try {
        await enforceOwnerSubscriptionForManagement(client, id);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
    }

    const result = await client.query(
      `UPDATE users
       SET name = $1,
           phone = $2,
           email = $3,
           photo_url = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING id, uuid, name, email, phone, role, shop_id, photo_url, whatsapp_link, created_at, updated_at`,
      [
        finalName,
        finalPhone,
        nextEmail ? nextEmail : existing.email,
        nextPhotoUrl,
        id
      ]
    );

    if (roleStr.includes('owner') && nextEmail) {
      await client.query(
        `UPDATE barber_shops
         SET schedule = jsonb_set(COALESCE(schedule, '{}'::jsonb), '{email}', to_jsonb($1::text), true),
             updated_at = NOW()
         WHERE owner_id = $2`,
        [nextEmail, id]
      );
    }

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    console.error('Error al actualizar perfil:', error);
    res.status(500).json({ message: 'Error del servidor al actualizar perfil' });
  } finally {
    client.release();
  }
};

export const changeUserPassword = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    if (!requireSelfOrAdmin(req, res, id)) return;
    const {
      currentPassword,
      contrasenaActual,
      newPassword,
      nuevaContrasena
    } = req.body || {};

    const currentPwd = currentPassword || contrasenaActual;
    const nextPwd = newPassword || nuevaContrasena;

    if (!currentPwd || !nextPwd) {
      return res.status(400).json({ message: 'Debes enviar contraseña actual y nueva contraseña.' });
    }

    await client.query('BEGIN');

    const existingResult = await client.query('SELECT id, password FROM users WHERE id = $1', [id]);
    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const existing = existingResult.rows[0];
    const ok = await bcrypt.compare(currentPwd, existing.password);
    if (!ok) {
      await client.query('ROLLBACK');
      return res.status(401).json({ message: 'Contraseña actual incorrecta' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(nextPwd, salt);

    await client.query(
      `UPDATE users
       SET password = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [hashedPassword, id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    console.error('Error al cambiar contraseña:', error);
    res.status(500).json({ message: 'Error del servidor al cambiar contraseña' });
  } finally {
    client.release();
  }
};

// Crear un nuevo usuario
export const createUser = async (req, res) => {
  const client = await pool.connect();
  try {
    logDbSuccess('CONEXIÓN', 'Cliente de base de datos conectado correctamente');
    
    await client.query('BEGIN');
    logDbSuccess('TRANSACCIÓN', 'Transacción iniciada');
    
    const {
      nombre,
      name,
      email,
      password,
      telefono,
      phone,
      role,
      rol,
      whatsappLink,
      whatsapp_link,
      photoUrl,
      photo_url,
      gender,
      genero,
      sexo
    } = req.body;

    // Normalizar campos para aceptar tanto español como inglés
    const finalName = nombre || name;
    const finalPhone = telefono || phone;
    const finalPhotoUrl = photoUrl || photo_url || null;
    const finalWhatsappLink = (whatsappLink !== undefined)
      ? whatsappLink
      : (whatsapp_link !== undefined ? whatsapp_link : null);
    const desiredRole = (rol || role || 'client').toLowerCase();
    const allowedCreateRoles = new Set(['client', 'owner', 'barber']);
    const safeDesiredRole = allowedCreateRoles.has(desiredRole) ? desiredRole : 'client';
    const adminJwt = getAdminFromOptionalJwt(req);
    const finalRole = adminJwt ? safeDesiredRole : 'client';

    const rawGender = (gender !== undefined ? gender : (genero !== undefined ? genero : sexo));
    const normalizedGender = rawGender == null
      ? null
      : String(rawGender || '').trim().toLowerCase();
    const finalGender = (normalizedGender === 'male' || normalizedGender === 'female' || normalizedGender === 'other')
      ? normalizedGender
      : null;
    
    // Verificar si el email ya existe
    const emailCheck = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    logDbSuccess('SELECT', `Verificación de email ${email} completada`);
    
    if (emailCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      logDbSuccess('TRANSACCIÓN', 'Rollback ejecutado - Email ya registrado');
      return res.status(400).json({ message: 'El email ya está registrado' });
    }
    
    // Encriptar la contraseña
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    logDbSuccess('BCRYPT', 'Contraseña encriptada correctamente');
    
    // Insertar el usuario
    const result = await client.query(`
      INSERT INTO users (
        name, 
        email, 
        password,
        phone,
        role,
        photo_url,
        whatsapp_link,
        gender
      ) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, name as nombre, email, phone as telefono, role, photo_url, whatsapp_link, gender
    `, [
      finalName,
      email,
      hashedPassword,
      finalPhone,
      finalRole,
      finalPhotoUrl,
      finalWhatsappLink != null ? String(finalWhatsappLink) : null,
      finalGender
    ]);
    
    logDbSuccess('INSERT', `Usuario creado con éxito: ID=${result.rows[0].id}, Nombre=${result.rows[0].nombre}`);
    
    await client.query('COMMIT');
    logDbSuccess('TRANSACCIÓN', 'Transacción confirmada (COMMIT) exitosamente');
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear usuario:', error);
    res.status(500).json({ message: 'Error del servidor al crear usuario' });
  } finally {
    client.release();
    logDbSuccess('CONEXIÓN', 'Cliente de base de datos liberado correctamente');
  }
};

// Actualizar un usuario
export const updateUser = async (req, res) => {
  const client = await pool.connect();
  try {
    logDbSuccess('CONEXIÓN', 'Cliente de base de datos conectado correctamente');

    const { id } = req.params;
    const {
      nombre,
      name,
      email,
      password,
      telefono,
      phone,
      role,
      shop_id,
      shopId,
      canDeleteHistory,
      can_delete_history,
      whatsappLink,
      whatsapp_link,
      photoUrl,
      photo_url,
      gender,
      genero,
      sexo
    } = req.body;

    console.log('updateUser - cuerpo recibido:', req.body);

    await client.query('BEGIN');
    logDbSuccess('TRANSACCIÓN', 'Transacción iniciada para actualizar usuario');

    // 1) Verificar que el usuario existe y obtener sus datos actuales
    const existingResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const existing = existingResult.rows[0];

    // 2) Si se actualiza el email, verificar que no esté en uso por otro usuario
    if (email) {
      const emailCheck = await client.query(
        'SELECT 1 FROM users WHERE email = $1 AND id != $2',
        [email, id]
      );
      if (emailCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'El email ya está registrado por otro usuario' });
      }
    }

    // 3) Normalizar campos de entrada
    const finalName = nombre || name || existing.name;
    const finalPhone = telefono || phone || existing.phone;
    const finalPhotoUrl = (photoUrl !== undefined || photo_url !== undefined)
      ? (photoUrl || photo_url || null)
      : existing.photo_url;

    const finalWhatsappLink = (whatsappLink !== undefined || whatsapp_link !== undefined)
      ? String((whatsappLink !== undefined ? whatsappLink : whatsapp_link) || '')
      : existing.whatsapp_link;

    const rawGender = (gender !== undefined ? gender : (genero !== undefined ? genero : sexo));
    const normalizedGender = rawGender === undefined
      ? existing.gender
      : (rawGender == null ? null : String(rawGender || '').trim().toLowerCase());
    const finalGender = (normalizedGender === 'male' || normalizedGender === 'female' || normalizedGender === 'other' || normalizedGender == null)
      ? normalizedGender
      : existing.gender;

    // ShopId: admitir tanto shop_id como shopId y permitir null para "no asignado"
    let finalShopId;
    if (shop_id !== undefined) {
      finalShopId = shop_id;
    } else if (shopId !== undefined) {
      finalShopId = shopId;
    } else {
      finalShopId = existing.shop_id;
    }

    // Validar tipo de shop_id si no es null
    if (finalShopId !== null && finalShopId !== undefined) {
      const parsed = Number(finalShopId);
      if (Number.isNaN(parsed)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'shop_id inválido, debe ser numérico o null' });
      }
      finalShopId = parsed;
    }

    if (String(finalShopId ?? '') !== String(existing.shop_id ?? '')) {
      const shopToCheck = finalShopId != null ? finalShopId : (existing.shop_id ?? null);
      if (shopToCheck != null) {
        try {
          await enforceShopSubscriptionForBooking(client, shopToCheck);
        } catch (e) {
          await client.query('ROLLBACK');
          return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
        }
      }
    }

    // 4) Manejar contraseña (solo si viene una nueva)
    let finalPassword = existing.password;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      finalPassword = await bcrypt.hash(password, salt);
      logDbSuccess('BCRYPT', 'Contraseña encriptada correctamente para actualización');
    }

    // 5) Rol: si no viene nada, mantener el actual
    const finalRole = role || existing.role;

    // Permiso: si no viene nada, mantener el actual
    const finalCanDeleteHistory = (canDeleteHistory !== undefined || can_delete_history !== undefined)
      ? Boolean(canDeleteHistory !== undefined ? canDeleteHistory : can_delete_history)
      : Boolean(existing.can_delete_history);

    // 6) Ejecutar UPDATE con parámetros fijos
    const updateQuery = `
      UPDATE users
      SET
        name = $1,
        email = $2,
        password = $3,
        phone = $4,
        role = $5,
        shop_id = $6,
        photo_url = $7,
        can_delete_history = $8,
        whatsapp_link = $9,
        gender = $10,
        updated_at = NOW()
      WHERE id = $11
      RETURNING id, uuid, name, email, phone, role, shop_id, photo_url, can_delete_history, whatsapp_link, gender, created_at, updated_at
    `;

    const updateValues = [
      finalName,
      email || existing.email,
      finalPassword,
      finalPhone,
      finalRole,
      finalShopId,
      finalPhotoUrl,
      finalCanDeleteHistory,
      finalWhatsappLink,
      finalGender,
      id
    ];

    const result = await client.query(updateQuery, updateValues);
    logDbSuccess('UPDATE', `Usuario con ID=${id} actualizado correctamente`);

    await client.query('COMMIT');
    logDbSuccess('TRANSACCIÓN', 'Transacción confirmada (COMMIT) exitosamente');

    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar usuario:', error);
    res.status(500).json({ message: 'Error del servidor al actualizar usuario', detalle: error.message });
  } finally {
    client.release();
    logDbSuccess('CONEXIÓN', 'Cliente de base de datos liberado correctamente');
  }
};

// Eliminar un usuario
export const deleteUser = async (req, res) => {
  const client = await pool.connect();
  try {
    logDbSuccess('CONEXIÓN', 'Cliente de base de datos conectado correctamente');
    
    await client.query('BEGIN');
    logDbSuccess('TRANSACCIÓN', 'Transacción iniciada para eliminar usuario');
    
    const { id } = req.params;
    
    // Verificar que el usuario existe
    const checkResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    logDbSuccess('SELECT', `Verificación de existencia de usuario con ID=${id} completada`);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      logDbSuccess('TRANSACCIÓN', `Rollback ejecutado - Usuario con ID=${id} no encontrado`);
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    
    const userData = checkResult.rows[0];
    logDbSuccess('INFO', `Usuario encontrado: ${userData.name || 'Sin nombre'} (${userData.email || 'Sin email'})`);

    const roleStr = String(userData.role || '').toLowerCase();
    if (roleStr.includes('admin')) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'No puedes eliminar la cuenta de administrador.' });
    }
    if (roleStr.includes('owner')) {
      const countRes = await client.query(
        'SELECT COUNT(*)::int as count FROM barber_shops WHERE owner_id = $1',
        [id]
      );
      const count = Number(countRes.rows[0]?.count ?? 0) || 0;
      if (count > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'No puedes eliminar este dueño porque todavía tiene negocios. Elimina los negocios o elimina la cuenta del dueño.'
        });
      }
    }

    // Revocar sesiones activas
    await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);

    // Conversaciones y mensajes: borrar conversaciones asociadas (messages tiene ON DELETE CASCADE por conversation_id)
    await client.query('DELETE FROM conversations WHERE client_id = $1 OR barber_id = $1 OR owner_id = $1', [id]);

    // Soft delete + anonimización
    const anonymizedEmail = `deleted+${id}@stylex.invalid`;
    await client.query(
      `UPDATE users
       SET deleted_at = NOW(),
           email = $2,
           name = COALESCE(NULLIF(name, ''), 'Usuario eliminado'),
           phone = NULL,
           whatsapp_link = NULL,
           photo_url = NULL,
           shop_id = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id, anonymizedEmail]
    );
    logDbSuccess('UPDATE', `Usuario con ID=${id} archivado (soft delete) correctamente`);
    
    await client.query('COMMIT');
    logDbSuccess('TRANSACCIÓN', 'Transacción confirmada (COMMIT) exitosamente');
    
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar usuario:', error);
    res.status(500).json({ message: 'Error del servidor al eliminar usuario' });
  } finally {
    client.release();
    logDbSuccess('CONEXIÓN', 'Cliente de base de datos liberado correctamente');
  }
};

// Autenticar usuario
export const loginUser = async (req, res) => {
  try {
    // Depurar el cuerpo de la solicitud
    console.log('Datos recibidos para login:', req.body);
    
    // Aceptar credenciales tanto en inglés como en español
    const email = req.body.email;
    const password = req.body.password || req.body.contrasena;
    
    if (!email || !password) {
      console.log('Error: Credenciales incompletas. Email o contraseña faltantes.');
      return res.status(400).json({ message: 'Credenciales incompletas. Se requiere email y contraseña' });
    }
    
    logDbSuccess('AUTENTICACIÓN', `Intento de login para usuario: ${email}`);
    
    // Buscar el usuario por email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    logDbSuccess('SELECT', `Búsqueda de usuario por email completada: ${email}`);
    
    if (result.rows.length === 0) {
      console.log(`Usuario no encontrado en la BD: ${email}`);
      logDbSuccess('AUTENTICACIÓN', `Intento fallido: Email ${email} no encontrado`);
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }
    
    const user = result.rows[0];
    logDbSuccess('INFO', `Usuario encontrado en BD: ID=${user.id}, Nombre=${user.name || 'Sin nombre'}`);

    if (user?.deleted_at) {
      return res.status(403).json({ message: 'Esta cuenta fue eliminada.' });
    }
    
    // Depurar hash de contraseña almacenada (solo para depuración)
    console.log(`Hash almacenado para ${email}:`, user.password);
    console.log(`Contraseña proporcionada:`, password);
    
    // TEMPORAL - PARA DEPURACIÓN - Verificar primero con contraseña sin hash si falla bcrypt
    // Solo para propósitos de depuración
    let isPasswordValid = false;
    
    try {
      // Intento normal con bcrypt
      isPasswordValid = await bcrypt.compare(password, user.password);
      console.log(`Resultado de bcrypt.compare:`, isPasswordValid);
    } catch (bcryptError) {
      console.error('Error en bcrypt.compare:', bcryptError);
      // Si hay error en bcrypt, intentamos una comparación simple (solo para depuración)
      isPasswordValid = false;
    }
    
    if (!isPasswordValid) {
      // Solo para depuración - comprobar si es contraseña de test
      if ((email === 'admin@stylex.app' && password === 'Admin123!') ||
          (email === 'owner@stylex.app' && password === 'Admin123!') ||
          (email === 'barber@stylex.app' && password === 'Barber123!') ||
          (email === 'cliente@stylex.app' && password === 'Cliente123!')) {
        // Permitir login con contraseñas de test (solo para propósitos de demostración)
        console.log('Login permitido con credenciales de test - SOLO PARA DEMOSTRACIÓN');
        isPasswordValid = true;
      } else {
        logDbSuccess('AUTENTICACIÓN', `Intento fallido: Contraseña incorrecta para ${email}`);
        return res.status(401).json({ message: 'Credenciales inválidas' });
      }
    }
    
    logDbSuccess('AUTENTICACIÓN', `Login exitoso para usuario: ${email} (ID=${user.id})`);
    
    // Formatear la respuesta con los campos según el esquema real
    const userResponse = {
      id: user.id,
      uuid: user.uuid,
      // Incluir campos tanto en español como en inglés para mayor compatibilidad
      nombre: user.name,
      name: user.name,
      email: user.email,
      telefono: user.phone,
      phone: user.phone,
      rol: user.role,
      role: user.role,
      especialidades: user.specialties || [],
      specialties: user.specialties || [],
      shop_id: user.shop_id,
      photo_url: user.photo_url,
      photoUrl: user.photo_url,
      whatsapp_link: user.whatsapp_link,
      whatsappLink: user.whatsapp_link,
      gender: user.gender
    };

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
    
    logDbSuccess('RESPUESTA', `Datos de usuario formateados y enviados: ID=${user.id}`);
    
    res.json({ ...userResponse, token });
  } catch (error) {
    console.error('Error al autenticar usuario:', error);
    res.status(500).json({ message: 'Error del servidor al autenticar usuario' });
  }
};
