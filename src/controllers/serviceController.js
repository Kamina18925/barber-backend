import pool from '../db/connection.js';
import { v4 as uuidv4 } from 'uuid';

// Obtener todos los servicios
export const getAllServices = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.id,
        s.uuid,
        s.name,
        s.description,
        s.price,
        s.duration,
        s.shop_id,
        bs.name as shop_name
      FROM services s
      LEFT JOIN barber_shops bs ON s.shop_id = bs.id
      ORDER BY s.name
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener servicios:', error);
    res.status(500).json({ message: 'Error del servidor al obtener servicios' });
  }
};

// Obtener servicios por barbería (shop_id)
export const getServicesByShop = async (req, res) => {
  try {
    const { shopId } = req.params;

    const result = await pool.query(`
      SELECT 
        s.id,
        s.uuid,
        s.name,
        s.description,
        s.price,
        s.duration,
        s.shop_id,
        bs.name as shop_name
      FROM services s
      LEFT JOIN barber_shops bs ON s.shop_id = bs.id
      WHERE s.shop_id = $1
      ORDER BY s.name
    `, [shopId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener servicios por barbería:', error);
    res.status(500).json({ message: 'Error del servidor al obtener servicios por barbería' });
  }
};

// Obtener servicio por ID
export const getServiceById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        s.id,
        s.uuid,
        s.name,
        s.description,
        s.price,
        s.duration,
        s.shop_id,
        bs.name as shop_name
      FROM services s
      LEFT JOIN barber_shops bs ON s.shop_id = bs.id
      WHERE s.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener servicio por ID:', error);
    res.status(500).json({ message: 'Error del servidor al obtener servicio' });
  }
};

// Crear un nuevo servicio (general o asociado a una barbería)
export const createService = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Aceptar nombres en inglés y español
    const body = req.body || {};
    const {
      name,
      nombre,
      description,
      descripcion,
      price,
      precio,
      duration,
      duracion,
      shopId,
      shop_id
    } = body;

    const finalName = name || nombre;
    const finalDescription = description || descripcion || null;
    const finalPrice = price !== undefined ? Number(price) : (precio !== undefined ? Number(precio) : null);
    const finalDuration = duration !== undefined ? Number(duration) : (duracion !== undefined ? Number(duracion) : null);
    const finalShopId = shopId !== undefined ? shopId : (shop_id !== undefined ? shop_id : null);

    if (!finalName || finalName.trim() === '') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El nombre del servicio es obligatorio' });
    }

    if (finalPrice === null || Number.isNaN(finalPrice) || finalPrice <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El precio del servicio es obligatorio y debe ser numérico positivo' });
    }

    if (finalDuration === null || Number.isNaN(finalDuration) || finalDuration <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'La duración del servicio es obligatoria y debe ser numérica positiva' });
    }

    const uuid = uuidv4();

    const result = await client.query(
      `INSERT INTO services (
        uuid,
        name,
        description,
        price,
        duration,
        shop_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, uuid, name, description, price, duration, shop_id`,
      [
        uuid,
        finalName,
        finalDescription,
        finalPrice,
        finalDuration,
        finalShopId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear servicio:', error);
    res.status(500).json({ message: 'Error del servidor al crear servicio' });
  } finally {
    client.release();
  }
};

// Actualizar un servicio
export const updateService = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    // Normalizar cuerpo
    const body = req.body || {};
    const {
      name,
      nombre,
      description,
      descripcion,
      price,
      precio,
      duration,
      duracion,
      shopId,
      shop_id
    } = body;

    const finalName = name || nombre;
    const finalDescription = description || descripcion || null;
    const finalPrice = price !== undefined ? Number(price) : (precio !== undefined ? Number(precio) : null);
    const finalDuration = duration !== undefined ? Number(duration) : (duracion !== undefined ? Number(duracion) : null);
    const finalShopId = shopId !== undefined ? shopId : (shop_id !== undefined ? shop_id : null);

    // Verificar que el servicio existe
    const checkResult = await client.query('SELECT * FROM services WHERE id = $1', [id]);

    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Servicio no encontrado' });
    }

    if (!finalName || finalName.trim() === '') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El nombre del servicio es obligatorio' });
    }

    if (finalPrice === null || Number.isNaN(finalPrice) || finalPrice <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El precio del servicio es obligatorio y debe ser numérico positivo' });
    }

    if (finalDuration === null || Number.isNaN(finalDuration) || finalDuration <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'La duración del servicio es obligatoria y debe ser numérica positiva' });
    }

    const result = await client.query(
      `UPDATE services 
       SET 
         name = $1,
         description = $2,
         price = $3,
         duration = $4,
         shop_id = $5,
         updated_at = NOW()
       WHERE id = $6
       RETURNING id, uuid, name, description, price, duration, shop_id`,
      [
        finalName,
        finalDescription,
        finalPrice,
        finalDuration,
        finalShopId,
        id
      ]
    );

    await client.query('COMMIT');

    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar servicio:', error);
    res.status(500).json({ message: 'Error del servidor al actualizar servicio' });
  } finally {
    client.release();
  }
};

// Eliminar un servicio (solo si no tiene citas asociadas)
export const deleteService = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    // Verificar que el servicio existe
    const checkResult = await client.query('SELECT * FROM services WHERE id = $1', [id]);

    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Servicio no encontrado' });
    }

    // Verificar si hay citas asociadas a este servicio
    const appointmentsCheck = await client.query('SELECT 1 FROM appointments WHERE service_id = $1 LIMIT 1', [id]);

    if (appointmentsCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No se puede eliminar el servicio porque tiene citas asociadas' });
    }

    // Eliminar el servicio
    await client.query('DELETE FROM services WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar servicio:', error);
    res.status(500).json({ message: 'Error del servidor al eliminar servicio' });
  } finally {
    client.release();
  }
};
