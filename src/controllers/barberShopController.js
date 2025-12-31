import pool from '../db/connection.js';
import bcrypt from 'bcrypt';
import { enforceOwnerSubscriptionForManagement } from '../services/subscriptionService.js';

const normalizeCategories = (raw) => {
  const allowed = new Set(['barberia', 'salon_belleza', 'spa_estetica', 'unas', 'depilacion']);
  let arr = [];

  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string') {
    arr = raw.split(',');
  } else {
    arr = [];
  }

  const normalized = arr
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean)
    .filter(v => allowed.has(v));

  const unique = Array.from(new Set(normalized));
  return unique.length ? unique : ['barberia'];
};

// Obtener todas las barberías
export const getAllBarberShops = async (req, res) => {
  try {
    const includeOrphans = String(req.query?.includeOrphans ?? req.query?.include_orphans ?? '').toLowerCase() === 'true';
    const includeArchived = String(req.query?.includeArchived ?? req.query?.include_archived ?? '').toLowerCase() === 'true';

    const where = [];
    if (!includeArchived) where.push('bs.deleted_at IS NULL');
    if (!includeOrphans) where.push('u.id IS NOT NULL AND u.deleted_at IS NULL');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT 
        bs.id, 
        bs.uuid, 
        bs.name, 
        bs.address, 
        bs.schedule,
        COALESCE(bs.categories, ARRAY['barberia']::text[]) as categories,
        COALESCE(rv.avg_rating, bs.rating, 0.0) as rating,
        COALESCE(rv.review_count, 0) as review_count,
        u.name as owner_name,
        u.id as owner_id
      FROM barber_shops bs
      LEFT JOIN (
        SELECT shop_id,
               ROUND(AVG(rating)::numeric, 1) as avg_rating,
               COUNT(*)::int as review_count
        FROM reviews
        GROUP BY shop_id
      ) rv ON rv.shop_id = bs.id
      LEFT JOIN users u ON bs.owner_id = u.id
      ${whereSql}
      ORDER BY bs.name
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener barberías:', error);
    res.status(500).json({ message: 'Error del servidor al obtener barberías' });
  }
};

// Obtener barberías por propietario
export const getBarberShopsByOwner = async (req, res) => {
  try {
    const { ownerId } = req.params;
    const includeArchived = String(req.query?.includeArchived ?? req.query?.include_archived ?? '').toLowerCase() === 'true';
    
    const result = await pool.query(`
      SELECT 
        id, 
        uuid, 
        name, 
        address,
        schedule,
        COALESCE(categories, ARRAY['barberia']::text[]) as categories,
        rating,
        owner_id
      FROM barber_shops
      WHERE owner_id = $1
      ${includeArchived ? '' : 'AND deleted_at IS NULL'}
      ORDER BY name
    `, [ownerId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener barberías por propietario:', error);
    res.status(500).json({ message: 'Error del servidor al obtener barberías por propietario' });
  }
};

// Obtener barbería por ID
export const getBarberShopById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT 
        bs.id,
        bs.uuid,
        bs.name,
        bs.address,
        bs.schedule,
        COALESCE(bs.categories, ARRAY['barberia']::text[]) as categories,
        COALESCE(rv.avg_rating, bs.rating, 0.0) as rating,
        COALESCE(rv.review_count, 0) as review_count,
        bs.owner_id,
        u.name as owner_name
      FROM barber_shops bs
      LEFT JOIN (
        SELECT shop_id,
               ROUND(AVG(rating)::numeric, 1) as avg_rating,
               COUNT(*)::int as review_count
        FROM reviews
        GROUP BY shop_id
      ) rv ON rv.shop_id = bs.id
      LEFT JOIN users u ON bs.owner_id = u.id
      WHERE bs.id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Barbería no encontrada' });
    }

    const barbersResult = await pool.query(
      `
      SELECT 
        id,
        uuid,
        name,
        email,
        phone,
        role,
        specialties,
        shop_id
      FROM users
      WHERE shop_id = $1 AND LOWER(role) = 'barber'
      ORDER BY name
      `,
      [id]
    );

    const servicesResult = await pool.query(
      `
      SELECT 
        id,
        uuid,
        name,
        description,
        price,
        duration,
        shop_id
      FROM services
      WHERE shop_id = $1
      ORDER BY name
      `,
      [id]
    );

    const barberShop = {
      ...result.rows[0],
      barbers: barbersResult.rows,
      services: servicesResult.rows
    };

    res.json(barberShop);
  } catch (error) {
    console.error('Error al obtener barbería por ID:', error);
    res.status(500).json({ message: 'Error del servidor al obtener barbería' });
  }
};

export const getBarberShopReviews = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT
         r.id,
         r.uuid,
         r.rating,
         r.comment,
         r.photo_url,
         r.appointment_id,
         r.created_at,
         u.id as user_id,
         u.name as user_name,
         u.photo_url as user_photo_url
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       WHERE r.shop_id = $1
       ORDER BY r.created_at DESC`,
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener reseñas:', error);
    res.status(500).json({ message: 'Error del servidor al obtener reseñas' });
  }
};

export const addBarberShopReview = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const shopId = Number(id);
    const {
      userId,
      appointmentId,
      rating,
      comment,
      photoUrl,
      photo_url
    } = req.body || {};

    const finalUserId = userId;
    const finalAppointmentId = appointmentId;
    const finalRating = Number(rating);
    const finalComment = comment != null ? String(comment) : null;
    const incomingPhotoUrl = (photoUrl !== undefined ? photoUrl : photo_url);

    if (!shopId || Number.isNaN(shopId)) {
      return res.status(400).json({ message: 'shopId inválido' });
    }

    if (!finalUserId || !finalAppointmentId) {
      return res.status(400).json({ message: 'userId y appointmentId son requeridos' });
    }

    if (!Number.isFinite(finalRating) || finalRating < 1 || finalRating > 5) {
      return res.status(400).json({ message: 'rating inválido (1-5)' });
    }

    await client.query('BEGIN');

    const apptCheck = await client.query(
      `SELECT id
       FROM appointments
       WHERE id = $1
         AND shop_id = $2
         AND client_id = $3
         AND status = 'completed'
         AND COALESCE(client_reviewed, FALSE) = FALSE
       LIMIT 1`,
      [finalAppointmentId, shopId, finalUserId]
    );

    if (apptCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'No tienes una cita completada pendiente de reseña para esta barbería.' });
    }

    let finalPhotoUrl = incomingPhotoUrl;
    if (finalPhotoUrl === undefined) {
      const userRes = await client.query('SELECT photo_url FROM users WHERE id = $1', [finalUserId]);
      finalPhotoUrl = userRes.rows[0]?.photo_url || null;
    }

    const insertRes = await client.query(
      `INSERT INTO reviews (shop_id, user_id, appointment_id, rating, comment, photo_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, uuid, shop_id, user_id, appointment_id, rating, comment, photo_url, created_at`,
      [shopId, finalUserId, finalAppointmentId, finalRating, finalComment, finalPhotoUrl]
    );

    await client.query(
      'UPDATE appointments SET client_reviewed = TRUE, updated_at = NOW() WHERE id = $1',
      [finalAppointmentId]
    );

    const summaryRes = await client.query(
      `SELECT
         COALESCE(ROUND(AVG(rating)::numeric, 1), 0.0) as rating,
         COUNT(*)::int as review_count
       FROM reviews
       WHERE shop_id = $1`,
      [shopId]
    );

    const nextRating = Number(summaryRes.rows[0]?.rating ?? 0) || 0;
    const reviewCount = Number(summaryRes.rows[0]?.review_count ?? 0) || 0;

    await client.query(
      'UPDATE barber_shops SET rating = $1, updated_at = NOW() WHERE id = $2',
      [nextRating, shopId]
    );

    await client.query('COMMIT');
    res.status(201).json({
      review: insertRes.rows[0],
      rating: nextRating,
      reviewCount,
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    console.error('Error al crear reseña:', error);
    res.status(500).json({ message: 'Error del servidor al crear reseña' });
  } finally {
    client.release();
  }
};

// Crear una nueva barbería
export const createBarberShop = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      nombre,
      name,
      direccion,
      address,
      ciudad,
      city,
      telefono,
      phone,
      whatsapp,
      whatsappLink,
      whatsapp_link,
      email,
      photoUrl,
      owner_id,
      ownerId,
      horario,
      openHours,
      descripcion,
      description,
      ownerName,
      ownerEmail,
      ownerPassword,
      ownerIsAlsoBarber,
      categories
    } = req.body;

    console.log('createBarberShop - body recibido:', req.body);

    // Normalizar campos para aceptar tanto español como inglés
    const finalName = nombre || name;
    const finalAddress = direccion || address || '';
    const finalPhone = telefono || phone || null;
    const finalCity = ciudad || city || null;
    const finalEmail = email || null;
    const finalPhotoUrl = photoUrl || null;
    const finalOwnerId = owner_id || ownerId || null;
    const finalDescription = descripcion || description || null;
    const finalSchedule = horario || openHours || null;
    const finalWhatsappLink = whatsappLink || whatsapp_link || whatsapp || null;
    const finalCategories = normalizeCategories(categories);

    if (!finalName) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El nombre de la barbería es obligatorio' });
    }

    // Guardar información adicional en el campo schedule (JSONB)
    const scheduleJson = {
      openHours: finalSchedule,
      phone: finalPhone,
      city: finalCity,
      description: finalDescription,
      email: finalEmail,
      photoUrl: finalPhotoUrl,
      ...(finalWhatsappLink ? { whatsappLink: String(finalWhatsappLink) } : {})
    };

    // Determinar/crear el usuario dueño si se enviaron datos específicos
    let ownerUserId = finalOwnerId;

    if (ownerEmail && ownerPassword) {
      console.log('createBarberShop - procesando datos de dueño:', {
        ownerName,
        ownerEmail,
        ownerIsAlsoBarber
      });
      // Buscar si ya existe un usuario con ese email
      const existingOwner = await client.query('SELECT id FROM users WHERE email = $1', [ownerEmail]);

      if (existingOwner.rows.length > 0) {
        console.log('createBarberShop - dueño existente reutilizado, id =', existingOwner.rows[0].id);
        ownerUserId = existingOwner.rows[0].id;
      } else {
        // Crear nuevo usuario dueño
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(ownerPassword, salt);

        const ownerInsert = await client.query(
          `
          INSERT INTO users (name, email, password, role)
          VALUES ($1, $2, $3, $4)
          RETURNING id
          `,
          [ownerName || finalName, ownerEmail, hashedPassword, 'owner']
        );

        console.log('createBarberShop - nuevo dueño creado, id =', ownerInsert.rows[0].id);
        ownerUserId = ownerInsert.rows[0].id;
      }
    }

    if (ownerUserId != null) {
      try {
        await enforceOwnerSubscriptionForManagement(client, ownerUserId);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
    }

    const insertResult = await client.query(
      `
      INSERT INTO barber_shops (
        name,
        address,
        schedule,
        rating,
        owner_id,
        categories
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, address, schedule, rating, owner_id, categories
      `,
      [finalName, finalAddress, scheduleJson, null, ownerUserId, finalCategories]
    );

    const shop = insertResult.rows[0];

    // Si el dueño también trabajará como barbero, asignarle esta barbería
    if (ownerUserId && ownerIsAlsoBarber) {
      console.log('createBarberShop - asignando shop_id al dueño como barbero:', {
        ownerUserId,
        shopId: shop.id
      });
      await client.query(
        'UPDATE users SET shop_id = $1 WHERE id = $2',
        [shop.id, ownerUserId]
      );
    }

    await client.query('COMMIT');

    res.status(201).json(shop);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear barbería:', error);
    res.status(500).json({ message: 'Error del servidor al crear barbería' });
  } finally {
    client.release();
  }
};

// Actualizar una barbería
export const updateBarberShop = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const {
      nombre,
      name,
      direccion,
      address,
      ciudad,
      city,
      telefono,
      phone,
      whatsapp,
      whatsappLink,
      whatsapp_link,
      email,
      photoUrl,
      horario,
      openHours,
      descripcion,
      description,
      sector,
      latitude,
      longitude,
      lat,
      lng,
      owner_id,
      ownerId,
      categories
    } = req.body;
    
    // Verificar que la barbería existe
    const checkResult = await client.query('SELECT * FROM barber_shops WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Barbería no encontrada' });
    }

    const existing = checkResult.rows[0];

    // Normalizar campos
    const finalName = nombre || name || existing.name;
    const finalAddress = direccion || address || existing.address || '';
    const finalPhone = telefono || phone || null;
    const finalCity = ciudad || city || null;
    const finalEmail = email || null;
    const finalPhotoUrl = photoUrl || null;
    const finalDescription = descripcion || description || null;
    const finalOwnerId = owner_id || ownerId || existing.owner_id || null;
    const finalSchedule = horario || openHours || null;
    const finalSector = sector || null;
    const finalLatitude = latitude !== undefined ? latitude : (lat !== undefined ? lat : null);
    const finalLongitude = longitude !== undefined ? longitude : (lng !== undefined ? lng : null);
    const finalWhatsappLink = (whatsappLink !== undefined)
      ? whatsappLink
      : (whatsapp_link !== undefined ? whatsapp_link : (whatsapp !== undefined ? whatsapp : undefined));

    // Reconstruir schedule JSONB mezclando con el existente
    const currentSchedule = existing.schedule || {};
    const currentCategories = Array.isArray(existing.categories) && existing.categories.length
      ? existing.categories
      : ['barberia'];
    const finalCategories = categories !== undefined ? normalizeCategories(categories) : currentCategories;

    const ownerToCheck = finalOwnerId != null ? finalOwnerId : (existing.owner_id ?? null);
    if (ownerToCheck != null) {
      try {
        await enforceOwnerSubscriptionForManagement(client, ownerToCheck);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
    }
    const scheduleJson = {
      ...currentSchedule,
      ...(finalSchedule !== null ? { openHours: finalSchedule } : {}),
      ...(finalPhone !== null ? { phone: finalPhone } : {}),
      ...(finalCity !== null ? { city: finalCity } : {}),
      ...(finalSector !== null ? { sector: finalSector } : {}),
      ...(finalLatitude != null ? { latitude: String(finalLatitude) } : {}),
      ...(finalLongitude != null ? { longitude: String(finalLongitude) } : {}),
      ...(finalDescription !== null ? { description: finalDescription } : {}),
      ...(finalEmail !== null ? { email: finalEmail } : {}),
      ...(finalPhotoUrl !== null ? { photoUrl: finalPhotoUrl } : {}),
      ...(finalWhatsappLink !== undefined ? { whatsappLink: String(finalWhatsappLink || '') } : {})
    };

    const updateQuery = `
      UPDATE barber_shops 
      SET 
        name = $1,
        address = $2,
        schedule = $3,
        categories = $4,
        owner_id = $5,
        updated_at = NOW()
      WHERE id = $6
      RETURNING id, name, address, schedule, rating, owner_id, categories
    `;
    
    const result = await client.query(updateQuery, [
      finalName,
      finalAddress,
      scheduleJson,
      finalCategories,
      finalOwnerId,
      id
    ]);

    await client.query('COMMIT');

    // Por ahora no devolvemos lista de barberos desde aquí
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar barbería:', error);
    res.status(500).json({ message: 'Error del servidor al actualizar barbería' });
  } finally {
    client.release();
  }
};

// Eliminar una barbería
export const deleteBarberShop = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const force = String(req.query?.force || '').toLowerCase() === 'true';
    
    // Verificar que la barbería existe
    const checkResult = await client.query('SELECT * FROM barber_shops WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Barbería no encontrada' });
    }

    const existing = checkResult.rows[0];
    if (existing?.deleted_at) {
      await client.query('COMMIT');
      return res.status(204).send();
    }

    const ownerId = existing?.owner_id ?? null;

    if (ownerId != null) {
      try {
        await enforceOwnerSubscriptionForManagement(client, ownerId);
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(e.status || 500).json({ message: e.message || 'Error del servidor' });
      }
    }

    if (ownerId != null && !force) {
      const countRes = await client.query(
        'SELECT COUNT(*)::int as count FROM barber_shops WHERE owner_id = $1 AND deleted_at IS NULL',
        [ownerId]
      );
      const count = Number(countRes.rows[0]?.count ?? 0) || 0;
      if (count <= 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: 'Este es tu único negocio. No puedes eliminarlo. Si deseas cerrarlo, elimina tu cuenta.'
        });
      }
    }
    
    // Desasignar barberos de esta barbería (poner shop_id a NULL)
    await client.query('UPDATE users SET shop_id = NULL WHERE shop_id = $1', [id]);

    // Archivar la barbería (soft delete). Se conserva el historial (citas, reseñas, etc.).
    await client.query(
      'UPDATE barber_shops SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1',
      [id]
    );
    
    await client.query('COMMIT');
    
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar barbería:', error);
    res.status(500).json({ message: 'Error del servidor al eliminar barbería' });
  } finally {
    client.release();
  }
};
