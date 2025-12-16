import pool from '../db/connection.js';
import bcrypt from 'bcrypt';

// Obtener todas las barberías
export const getAllBarberShops = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        bs.id, 
        bs.uuid, 
        bs.name, 
        bs.address, 
        bs.schedule,
        bs.rating, 
        u.name as owner_name,
        u.id as owner_id
      FROM barber_shops bs
      LEFT JOIN users u ON bs.owner_id = u.id
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
    
    const result = await pool.query(`
      SELECT 
        id, 
        uuid, 
        name, 
        address,
        schedule,
        rating,
        owner_id
      FROM barber_shops
      WHERE owner_id = $1
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
        bs.rating,
        bs.owner_id,
        u.name as owner_name
      FROM barber_shops bs
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
      ownerIsAlsoBarber
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
      photoUrl: finalPhotoUrl
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

    const insertResult = await client.query(
      `
      INSERT INTO barber_shops (
        name,
        address,
        schedule,
        rating,
        owner_id
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, address, schedule, rating, owner_id
      `,
      [finalName, finalAddress, scheduleJson, null, ownerUserId]
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
      telefono,
      phone,
      email,
      photoUrl,
      horario,
      openHours,
      descripcion,
      description,
      owner_id,
      ownerId
    } = req.body;
    
    // Verificar que la barbería existe
    const checkResult = await client.query('SELECT * FROM barber_shops WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Barbería no encontrada' });
    }

    // Normalizar campos
    const finalName = nombre || name || checkResult.rows[0].name;
    const finalAddress = direccion || address || checkResult.rows[0].address || '';
    const finalPhone = telefono || phone || null;
    const finalEmail = email || null;
    const finalPhotoUrl = photoUrl || null;
    const finalDescription = descripcion || description || null;
    const finalOwnerId = owner_id || ownerId || checkResult.rows[0].owner_id || null;
    const finalSchedule = horario || openHours || null;

    // Reconstruir schedule JSONB mezclando con el existente
    const currentSchedule = checkResult.rows[0].schedule || {};
    const scheduleJson = {
      ...currentSchedule,
      ...(finalSchedule !== null ? { openHours: finalSchedule } : {}),
      ...(finalPhone !== null ? { phone: finalPhone } : {}),
      ...(finalDescription !== null ? { description: finalDescription } : {}),
      ...(finalEmail !== null ? { email: finalEmail } : {}),
      ...(finalPhotoUrl !== null ? { photoUrl: finalPhotoUrl } : {})
    };

    const updateQuery = `
      UPDATE barber_shops 
      SET 
        name = $1,
        address = $2,
        schedule = $3,
        owner_id = $4,
        updated_at = NOW()
      WHERE id = $5
      RETURNING id, name, address, schedule, rating, owner_id
    `;
    
    const result = await client.query(updateQuery, [
      finalName,
      finalAddress,
      scheduleJson,
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
    
    // Verificar que la barbería existe
    const checkResult = await client.query('SELECT * FROM barber_shops WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Barbería no encontrada' });
    }
    
    // Desasignar barberos de esta barbería (poner shop_id a NULL)
    await client.query('UPDATE users SET shop_id = NULL WHERE shop_id = $1', [id]);

    await client.query(
      `
      DELETE FROM appointment_notes
      WHERE appointment_id IN (SELECT id FROM appointments WHERE shop_id = $1)
      `,
      [id]
    );

    await client.query(
      `
      DELETE FROM appointment_extras
      WHERE appointment_id IN (SELECT id FROM appointments WHERE shop_id = $1)
      `,
      [id]
    );

    await client.query(
      `
      DELETE FROM appointment_status_history
      WHERE appointment_id IN (SELECT id FROM appointments WHERE shop_id = $1)
      `,
      [id]
    );

    await client.query(
      `
      DELETE FROM conversations
      WHERE appointment_id IN (SELECT id FROM appointments WHERE shop_id = $1)
      `,
      [id]
    );

    await client.query('DELETE FROM appointments WHERE shop_id = $1', [id]);

    await client.query('DELETE FROM services WHERE shop_id = $1', [id]);
    await client.query('DELETE FROM products WHERE shop_id = $1', [id]);
    await client.query('DELETE FROM reviews WHERE shop_id = $1', [id]);

    // Eliminar la barbería
    await client.query('DELETE FROM barber_shops WHERE id = $1', [id]);
    
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
