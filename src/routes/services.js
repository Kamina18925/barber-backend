import express from 'express';
import pool from '../db/connection.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Get all master services (public)
router.get('/master', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM masterservices ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching master services:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get master services for a shop (public)
router.get('/shop/:shopId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ms.*
      FROM masterservices ms
      JOIN shopmasterservices sms ON ms.master_service_id = sms.master_service_id
      WHERE sms.shop_id = $1
      ORDER BY ms.name
    `, [req.params.shopId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching shop services:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a master service (owner only)
router.post('/master', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { name, description, basePrice, baseDurationMinutes, imageUrl, isGlobal = true } = req.body;
  
  try {
    const result = await pool.query(
      'INSERT INTO masterservices (name, description, base_price, base_duration_minutes, image_url, is_global) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, description, basePrice, baseDurationMinutes, imageUrl, isGlobal]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear servicio:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Update a master service (owner only)
router.put('/master/:id', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { name, description, basePrice, baseDurationMinutes, imageUrl } = req.body;
  const serviceId = req.params.id;
  
  try {
    // Obtener datos actuales del servicio, incluyendo la URL de la imagen
    const prevResult = await pool.query(
      'SELECT image_url FROM masterservices WHERE master_service_id = $1',
      [serviceId]
    );
    
    if (prevResult.rows.length === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado' });
    }
    
    const prevUrl = prevResult.rows[0]?.image_url;
    
    // Actualizar servicio
    const result = await pool.query(
      'UPDATE masterservices SET name = $1, description = $2, base_price = $3, base_duration_minutes = $4, image_url = $5, updated_at = NOW() WHERE master_service_id = $6 RETURNING *',
      [name, description, basePrice, baseDurationMinutes, imageUrl, serviceId]
    );
    
    // Si cambia la imagen y la anterior era local, borrarla
    if (prevUrl && prevUrl !== imageUrl && prevUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../../../', prevUrl);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('Error al eliminar imagen anterior del servicio:', err);
        } else {
          console.log(`Imagen anterior del servicio eliminada: ${filePath}`);
        }
      });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar servicio:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Assign a master service to a shop (owner only)
router.post('/shop/:shopId/assign', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { masterServiceId } = req.body;
  const shopId = req.params.shopId;
  
  try {
    // Check if user is the owner of this shop
    const shopCheck = await pool.query(
      'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
      [shopId, req.user.userId]
    );
    
    if (shopCheck.rows.length === 0) {
      return res.status(403).json({ message: 'You do not own this shop' });
    }
    
    // Check if service is already assigned
    const existingCheck = await pool.query(
      'SELECT * FROM shopmasterservices WHERE shop_id = $1 AND master_service_id = $2',
      [shopId, masterServiceId]
    );
    
    if (existingCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Service is already assigned to this shop' });
    }
    
    // Assign service
    await pool.query(
      'INSERT INTO shopmasterservices (shop_id, master_service_id) VALUES ($1, $2)',
      [shopId, masterServiceId]
    );
    
    res.status(201).json({ message: 'Service assigned to shop successfully' });
  } catch (error) {
    console.error('Error assigning service to shop:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Unassign a master service from a shop (owner only)
router.delete('/shop/:shopId/unassign/:serviceId', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { shopId, serviceId } = req.params;
  
  try {
    // Check if user is the owner of this shop
    const shopCheck = await pool.query(
      'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
      [shopId, req.user.userId]
    );
    
    if (shopCheck.rows.length === 0) {
      return res.status(403).json({ message: 'You do not own this shop' });
    }
    
    // Unassign service
    await pool.query(
      'DELETE FROM shopmasterservices WHERE shop_id = $1 AND master_service_id = $2',
      [shopId, serviceId]
    );
    
    res.json({ message: 'Service unassigned from shop successfully' });
  } catch (error) {
    console.error('Error unassigning service from shop:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get barber services (barber or owner)
router.get('/barber/:barberId', authenticateToken, async (req, res) => {
  const barberId = req.params.barberId;
  
  try {
    // Check authorization
    if (req.user.role === 'barber' && req.user.userId !== barberId) {
      return res.status(403).json({ message: 'You can only view your own services' });
    }
    
    if (req.user.role === 'owner') {
      // Check if barber works in owner's shop
      const shopCheck = await pool.query(`
        SELECT s.shop_id FROM barbershops s
        JOIN users u ON u.shop_id = s.shop_id
        WHERE u.user_id = $1 AND s.owner_id = $2
      `, [barberId, req.user.userId]);
      
      if (shopCheck.rows.length === 0) {
        return res.status(403).json({ message: 'This barber does not work in your shop' });
      }
    }
    
    // Get barber services
    const result = await pool.query(`
      SELECT bs.*, ms.name as master_service_name, ms.description as master_description, 
             ms.base_price, ms.base_duration_minutes
      FROM barberservices bs
      LEFT JOIN masterservices ms ON bs.master_service_id = ms.master_service_id
      WHERE bs.barber_id = $1
      ORDER BY bs.is_active DESC, ms.name, bs.personal_name
    `, [barberId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching barber services:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update barber service (barber only)
router.put('/barber/:serviceId', authenticateToken, authorizeRoles('barber'), async (req, res) => {
  const { personalName, personalDescription, priceByBarber, durationByBarber, isActive } = req.body;
  const serviceId = req.params.serviceId;
  
  try {
    // Check if this service belongs to the barber
    const serviceCheck = await pool.query(
      'SELECT * FROM barberservices WHERE barber_service_id = $1 AND barber_id = $2',
      [serviceId, req.user.userId]
    );
    
    if (serviceCheck.rows.length === 0) {
      return res.status(403).json({ message: 'This service does not belong to you' });
    }
    
    // Update service
    const result = await pool.query(`
      UPDATE barberservices 
      SET personal_name = $1, personal_description = $2, price_by_barber = $3, 
          duration_by_barber = $4, is_active = $5, updated_at = NOW()
      WHERE barber_service_id = $6
      RETURNING *
    `, [personalName, personalDescription, priceByBarber, durationByBarber, isActive, serviceId]);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating barber service:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create personal barber service (barber only)
router.post('/barber/personal', authenticateToken, authorizeRoles('barber'), async (req, res) => {
  const { personalName, personalDescription, priceByBarber, durationByBarber } = req.body;
  
  try {
    const result = await pool.query(`
      INSERT INTO barberservices 
      (barber_id, master_service_id, personal_name, personal_description, price_by_barber, duration_by_barber)
      VALUES ($1, NULL, $2, $3, $4, $5)
      RETURNING *
    `, [req.user.userId, personalName, personalDescription, priceByBarber, durationByBarber]);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating personal barber service:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add catalog service to barber (barber or owner)
router.post('/barber/:barberId/catalog', authenticateToken, async (req, res) => {
  const { masterServiceId } = req.body;
  const barberId = req.params.barberId;
  
  try {
    // Check authorization
    if (req.user.role === 'barber' && req.user.userId !== barberId) {
      return res.status(403).json({ message: 'You can only add services to yourself' });
    }
    
    if (req.user.role === 'owner') {
      // Check if barber works in owner's shop
      const shopCheck = await pool.query(`
        SELECT s.shop_id FROM barbershops s
        JOIN users u ON u.shop_id = s.shop_id
        WHERE u.user_id = $1 AND s.owner_id = $2
      `, [barberId, req.user.userId]);
      
      if (shopCheck.rows.length === 0) {
        return res.status(403).json({ message: 'This barber does not work in your shop' });
      }
    }
    
    // Check if service is already assigned
    const existingCheck = await pool.query(
      'SELECT * FROM barberservices WHERE barber_id = $1 AND master_service_id = $2',
      [barberId, masterServiceId]
    );
    
    if (existingCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Service is already assigned to this barber' });
    }
    
    // Add service
    const result = await pool.query(`
      INSERT INTO barberservices 
      (barber_id, master_service_id, personal_name, personal_description, price_by_barber, duration_by_barber)
      VALUES ($1, $2, NULL, NULL, NULL, NULL)
      RETURNING *
    `, [barberId, masterServiceId]);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error adding catalog service to barber:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Actualizar imagen de un servicio
router.post('/master/:id/image', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const { imageUrl } = req.body;
  const serviceId = req.params.id;
  
  if (!imageUrl) {
    return res.status(400).json({ message: 'URL de imagen requerida' });
  }
  
  try {
    // Obtener datos actuales del servicio, incluyendo la URL de la imagen
    const prevResult = await pool.query(
      'SELECT image_url FROM masterservices WHERE master_service_id = $1',
      [serviceId]
    );
    
    if (prevResult.rows.length === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado' });
    }
    
    const prevUrl = prevResult.rows[0]?.image_url;
    
    // Actualizar URL de la imagen
    const result = await pool.query(
      'UPDATE masterservices SET image_url = $1, updated_at = NOW() WHERE master_service_id = $2 RETURNING *',
      [imageUrl, serviceId]
    );
    
    // Si la imagen anterior era local, borrarla
    if (prevUrl && prevUrl !== imageUrl && prevUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../../../', prevUrl);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('Error al eliminar imagen anterior del servicio:', err);
        } else {
          console.log(`Imagen anterior del servicio eliminada: ${filePath}`);
        }
      });
    }
    
    res.json({
      success: true,
      service: result.rows[0],
      message: 'Imagen del servicio actualizada correctamente'
    });
  } catch (error) {
    console.error('Error al actualizar imagen del servicio:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Eliminar imagen de un servicio
router.delete('/master/:id/image', authenticateToken, authorizeRoles('owner'), async (req, res) => {
  const serviceId = req.params.id;
  
  try {
    // Obtener datos actuales del servicio, incluyendo la URL de la imagen
    const prevResult = await pool.query(
      'SELECT image_url FROM masterservices WHERE master_service_id = $1',
      [serviceId]
    );
    
    if (prevResult.rows.length === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado' });
    }
    
    const prevUrl = prevResult.rows[0]?.image_url;
    
    if (!prevUrl) {
      return res.status(400).json({ message: 'El servicio no tiene una imagen asociada' });
    }
    
    // Eliminar la referencia a la imagen
    await pool.query(
      'UPDATE masterservices SET image_url = NULL, updated_at = NOW() WHERE master_service_id = $1 RETURNING *',
      [serviceId]
    );
    
    // Si la imagen era local, borrarla
    if (prevUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../../../', prevUrl);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('Error al eliminar archivo de imagen del servicio:', err);
        } else {
          console.log(`Archivo de imagen del servicio eliminado: ${filePath}`);
        }
      });
    }
    
    res.json({
      success: true,
      message: 'Imagen del servicio eliminada correctamente'
    });
  } catch (error) {
    console.error('Error al eliminar imagen del servicio:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

export default router;