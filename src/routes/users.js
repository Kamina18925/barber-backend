import express from 'express';
import pool from '../db/connection.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT user_id, name, email, phone, role, profile_image_url, shop_id, created_at, updated_at FROM users WHERE user_id = $1',
      [req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update user profile
router.put('/profile', authenticateToken, async (req, res) => {
  const { name, phone, profile_image_url } = req.body;

  try {
    // Obtener la foto anterior
    const prevResult = await pool.query(
      'SELECT profile_image_url FROM users WHERE user_id = $1',
      [req.user.userId]
    );
    const prevUrl = prevResult.rows[0]?.profile_image_url;

    const result = await pool.query(
      'UPDATE users SET name = $1, phone = $2, profile_image_url = $3, updated_at = NOW() WHERE user_id = $4 RETURNING user_id, name, email, phone, role, profile_image_url, created_at, updated_at',
      [name, phone, profile_image_url, req.user.userId]
    );

    // Si cambia la foto y la anterior era local, la borra
    if (prevUrl && prevUrl !== profile_image_url && prevUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../../../', prevUrl);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('No se pudo borrar la foto anterior del perfil:', err);
        } else {
          console.log(`Foto de perfil antigua eliminada: ${filePath}`);
        }
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar el perfil de usuario:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Subir foto de perfil directamente
router.post('/profile/image', authenticateToken, async (req, res) => {
  try {
    // La imagen se maneja en la ruta /api/upload/profile
    // Esta ruta solo actualiza la referencia en la base de datos
    const { imageUrl } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ message: 'URL de imagen requerida' });
    }
    
    // Obtener la foto anterior
    const prevResult = await pool.query(
      'SELECT profile_image_url FROM users WHERE user_id = $1',
      [req.user.userId]
    );
    const prevUrl = prevResult.rows[0]?.profile_image_url;
    
    // Actualizar la URL de la imagen de perfil
    const result = await pool.query(
      'UPDATE users SET profile_image_url = $1, updated_at = NOW() WHERE user_id = $2 RETURNING user_id, name, email, phone, role, profile_image_url, created_at, updated_at',
      [imageUrl, req.user.userId]
    );
    
    // Si cambia la foto y la anterior era local, la borra
    if (prevUrl && prevUrl !== imageUrl && prevUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../../../', prevUrl);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('No se pudo borrar la foto anterior del perfil:', err);
        } else {
          console.log(`Foto de perfil antigua eliminada: ${filePath}`);
        }
      });
    }
    
    res.json({
      success: true, 
      user: result.rows[0],
      message: 'Imagen de perfil actualizada correctamente'
    });
  } catch (error) {
    console.error('Error al actualizar la imagen de perfil:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Change password
router.put('/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  try {
    // Get current password hash
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE user_id = $1',
      [req.user.userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Verify current password
    const passwordMatch = await bcrypt.compare(
      currentPassword,
      userResult.rows[0].password_hash
    );
    
    if (!passwordMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }
    
    // Hash new password
    const saltRounds = 10;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);
    
    // Update password
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2',
      [newPasswordHash, req.user.userId]
    );
    
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get barbers for a shop (public)
router.get('/barbers/shop/:shopId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.name, u.profile_image_url, u.shop_id,
       (SELECT json_agg(json_build_object(
         'barber_service_id', bs.barber_service_id,
         'master_service_id', bs.master_service_id,
         'personal_name', bs.personal_name,
         'personal_description', bs.personal_description,
         'price_by_barber', bs.price_by_barber,
         'duration_by_barber', bs.duration_by_barber,
         'is_active', bs.is_active
       )) FROM barberservices bs WHERE bs.barber_id = u.user_id) as services
       FROM users u
       WHERE u.role = 'barber' AND u.shop_id = $1`,
      [req.params.shopId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching barbers:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get barber availability
router.get('/barbers/:barberId/availability', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM barberavailability WHERE barber_id = $1 ORDER BY day_of_week',
      [req.params.barberId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching barber availability:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update barber availability (barber or owner only)
router.put('/barbers/:barberId/availability', authenticateToken, authorizeRoles('barber', 'owner'), async (req, res) => {
  const { availability } = req.body;
  const barberId = req.params.barberId;
  
  // Check if user is the barber or an owner of the shop where barber works
  try {
    let authorized = false;
    
    if (req.user.role === 'barber' && req.user.userId === barberId) {
      authorized = true;
    } else if (req.user.role === 'owner') {
      // Check if barber works in owner's shop
      const shopResult = await pool.query(
        `SELECT s.shop_id FROM barbershops s
         JOIN users u ON u.user_id = $1
         WHERE s.owner_id = $2`,
        [barberId, req.user.userId]
      );
      
      authorized = shopResult.rows.length > 0;
    }
    
    if (!authorized) {
      return res.status(403).json({ message: 'Not authorized to update this barber\'s availability' });
    }
    
    // Start transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Delete existing availability
      await client.query('DELETE FROM barberavailability WHERE barber_id = $1', [barberId]);
      
      // Insert new availability
      for (const slot of availability) {
        await client.query(
          'INSERT INTO barberavailability (barber_id, day_of_week, start_time_local, end_time_local, is_active) VALUES ($1, $2, $3, $4, $5)',
          [barberId, slot.day_of_week, slot.start_time_local, slot.end_time_local, slot.is_active || true]
        );
      }
      
      await client.query('COMMIT');
      
      res.json({ message: 'Availability updated successfully' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating barber availability:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;