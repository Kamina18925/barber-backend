import express from 'express';
import pool from '../db/connection.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Get all shops (public)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, 
        (SELECT json_agg(json_build_object('photo_id', p.photo_id, 'photo_url', p.photo_url, 'is_primary', p.is_primary))
         FROM shopphotos p WHERE p.shop_id = s.shop_id) as photos,
        (SELECT json_agg(json_build_object(
          'day_of_week', h.day_of_week, 
          'opening_time', h.opening_time, 
          'closing_time', h.closing_time, 
          'is_closed', h.is_closed
        ))
         FROM shopopeninghours h WHERE h.shop_id = s.shop_id) as opening_hours
      FROM barbershops s
      ORDER BY s.rating_avg DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching shops:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get shop by ID (public)
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, 
        (SELECT json_agg(json_build_object('photo_id', p.photo_id, 'photo_url', p.photo_url, 'is_primary', p.is_primary))
         FROM shopphotos p WHERE p.shop_id = s.shop_id) as photos,
        (SELECT json_agg(json_build_object(
          'day_of_week', h.day_of_week, 
          'opening_time', h.opening_time, 
          'closing_time', h.closing_time, 
          'is_closed', h.is_closed
        ))
         FROM shopopeninghours h WHERE h.shop_id = s.shop_id) as opening_hours,
        (SELECT json_agg(r.*) FROM reviews r WHERE r.shop_id = s.shop_id) as reviews,
        (SELECT json_agg(ms.master_service_id) 
         FROM shopmasterservices sms 
         JOIN masterservices ms ON sms.master_service_id = ms.master_service_id 
         WHERE sms.shop_id = s.shop_id) as service_ids
      FROM barbershops s
      WHERE s.shop_id = $1
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Shop not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching shop:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new shop (owner only)
router.post('/', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { name, address, city, phone } = req.body;
  
  try {
    const result = await pool.query(
      'INSERT INTO barbershops (owner_id, name, address, city, phone) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.userId, name, address, city, phone]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating shop:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a shop (owner only)
router.put('/:id', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { name, address, city, phone } = req.body;
  
  try {
    // Check if user is the owner of this shop
    const shopCheck = await pool.query(
      'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (shopCheck.rows.length === 0) {
      return res.status(403).json({ message: 'You do not own this shop' });
    }
    
    const result = await pool.query(
      'UPDATE barbershops SET name = $1, address = $2, city = $3, phone = $4, updated_at = NOW() WHERE shop_id = $5 RETURNING *',
      [name, address, city, phone, req.params.id]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating shop:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get shops owned by current user (owner only)
router.get('/owner/my-shops', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, 
        (SELECT json_agg(json_build_object('photo_id', p.photo_id, 'photo_url', p.photo_url, 'is_primary', p.is_primary))
         FROM shopphotos p WHERE p.shop_id = s.shop_id) as photos
      FROM barbershops s
      WHERE s.owner_id = $1
      ORDER BY s.created_at DESC
    `, [req.user.userId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching owner shops:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update shop opening hours (owner only)
router.put('/:id/hours', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { openingHours } = req.body;
  const shopId = req.params.id;
  
  try {
    // Check if user is the owner of this shop
    const shopCheck = await pool.query(
      'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
      [shopId, req.user.userId]
    );
    
    if (shopCheck.rows.length === 0) {
      return res.status(403).json({ message: 'You do not own this shop' });
    }
    
    // Start transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Delete existing hours
      await client.query('DELETE FROM shopopeninghours WHERE shop_id = $1', [shopId]);
      
      // Insert new hours
      for (const [day, hours] of Object.entries(openingHours)) {
        let openingTime = null;
        let closingTime = null;
        let isClosed = true;
        
        if (hours !== 'Cerrado') {
          const [open, close] = hours.split('-');
          openingTime = open;
          closingTime = close;
          isClosed = false;
        }
        
        await client.query(
          'INSERT INTO shopopeninghours (shop_id, day_of_week, opening_time, closing_time, is_closed) VALUES ($1, $2, $3, $4, $5)',
          [shopId, day, openingTime, closingTime, isClosed]
        );
      }
      
      await client.query('COMMIT');
      
      res.json({ message: 'Opening hours updated successfully' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating shop hours:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add a review to a shop (client only)
router.post('/:id/reviews', authenticateToken, authorizeRoles('client'), async (req, res) => {
  const { rating, comment, appointmentId } = req.body;
  const shopId = req.params.id;
  
  try {
    // Insert review
    const result = await pool.query(
      'INSERT INTO reviews (shop_id, user_id, appointment_id, rating, comment) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [shopId, req.user.userId, appointmentId, rating, comment]
    );
    
    // Update shop rating
    await pool.query(`
      UPDATE barbershops
      SET rating_avg = (
        SELECT COALESCE(AVG(rating)::numeric(2,1), 0.0)
        FROM reviews
        WHERE shop_id = $1
      )
      WHERE shop_id = $1
    `, [shopId]);
    
    // If appointment provided, mark it as reviewed
    if (appointmentId) {
      await pool.query(
        'UPDATE appointments SET client_reviewed = true WHERE appointment_id = $1 AND client_id = $2',
        [appointmentId, req.user.userId]
      );
    }
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error adding review:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Gestión de fotos de tiendas (owner only)

// Añadir foto a una tienda
router.post('/:id/photos', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { photoUrl, isPrimary } = req.body;
  const shopId = req.params.id;
  
  try {
    // Verificar que el usuario es propietario de esta tienda
    const shopCheck = await pool.query(
      'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
      [shopId, req.user.userId]
    );
    
    if (shopCheck.rows.length === 0) {
      return res.status(403).json({ message: 'No eres propietario de esta barbería' });
    }
    
    // Si la nueva foto es principal, actualizar todas las demás a no principales
    if (isPrimary) {
      await pool.query(
        'UPDATE shopphotos SET is_primary = false WHERE shop_id = $1',
        [shopId]
      );
    }
    
    // Insertar la nueva foto
    const result = await pool.query(
      'INSERT INTO shopphotos (shop_id, photo_url, is_primary) VALUES ($1, $2, $3) RETURNING *',
      [shopId, photoUrl, isPrimary || false]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al añadir foto a la barbería:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Establecer foto principal
router.put('/:shopId/photos/:photoId/primary', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { shopId, photoId } = req.params;
  
  try {
    // Verificar que el usuario es propietario de esta tienda
    const shopCheck = await pool.query(
      'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
      [shopId, req.user.userId]
    );
    
    if (shopCheck.rows.length === 0) {
      return res.status(403).json({ message: 'No eres propietario de esta barbería' });
    }
    
    // Verificar que la foto existe y pertenece a esta tienda
    const photoCheck = await pool.query(
      'SELECT * FROM shopphotos WHERE photo_id = $1 AND shop_id = $2',
      [photoId, shopId]
    );
    
    if (photoCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Foto no encontrada' });
    }
    
    // Iniciar transacción
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Establecer todas las fotos como no principales
      await client.query(
        'UPDATE shopphotos SET is_primary = false WHERE shop_id = $1',
        [shopId]
      );
      
      // Establecer la foto seleccionada como principal
      await client.query(
        'UPDATE shopphotos SET is_primary = true WHERE photo_id = $1',
        [photoId]
      );
      
      await client.query('COMMIT');
      
      res.json({ message: 'Foto principal actualizada correctamente' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error al establecer foto principal:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Eliminar foto de tienda
router.delete('/:shopId/photos/:photoId', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { shopId, photoId } = req.params;
  
  try {
    // Verificar que el usuario es propietario de esta tienda
    const shopCheck = await pool.query(
      'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
      [shopId, req.user.userId]
    );
    
    if (shopCheck.rows.length === 0) {
      return res.status(403).json({ message: 'No eres propietario de esta barbería' });
    }
    
    // Obtener información de la foto antes de eliminarla
    const photoResult = await pool.query(
      'SELECT * FROM shopphotos WHERE photo_id = $1 AND shop_id = $2',
      [photoId, shopId]
    );
    
    if (photoResult.rows.length === 0) {
      return res.status(404).json({ message: 'Foto no encontrada' });
    }
    
    const photoData = photoResult.rows[0];
    const isPrimary = photoData.is_primary;
    const photoUrl = photoData.photo_url;
    
    // Iniciar transacción
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Eliminar la foto de la base de datos
      await client.query('DELETE FROM shopphotos WHERE photo_id = $1', [photoId]);
      
      // Si era la foto principal, establecer otra foto como principal (si existe)
      if (isPrimary) {
        const nextPhotoResult = await client.query(
          'SELECT photo_id FROM shopphotos WHERE shop_id = $1 LIMIT 1',
          [shopId]
        );
        
        if (nextPhotoResult.rows.length > 0) {
          await client.query(
            'UPDATE shopphotos SET is_primary = true WHERE photo_id = $1',
            [nextPhotoResult.rows[0].photo_id]
          );
        }
      }
      
      await client.query('COMMIT');
      
      // Si la foto estaba almacenada localmente, eliminarla del sistema de archivos
      if (photoUrl && photoUrl.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, '../../../', photoUrl);
        fs.unlink(filePath, (err) => {
          if (err) {
            console.error('Error al eliminar archivo físico de la foto:', err);
          } else {
            console.log(`Archivo de foto eliminado: ${filePath}`);
          }
        });
      }
      
      res.json({
        message: 'Foto eliminada correctamente',
        deletedPhoto: photoData
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error al eliminar foto de la barbería:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

export default router;