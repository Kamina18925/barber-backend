import express from 'express';
import pool from '../db/connection.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Get all products for a shop (public)
router.get('/shop/:shopId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.name as barber_name
      FROM products p
      LEFT JOIN users u ON p.barber_id = u.user_id
      WHERE p.shop_id = $1
      ORDER BY p.name
    `, [req.params.shopId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching shop products:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get products for a barber (public)
router.get('/barber/:barberId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM products WHERE barber_id = $1 ORDER BY name',
      [req.params.barberId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching barber products:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get my products (barber or owner)
router.get('/my', authenticateToken, authorizeRoles('barber', 'owner'), async (req, res) => {
  try {
    let query;
    let params = [];
    
    if (req.user.role === 'barber') {
      // Barbers see their personal products
      query = 'SELECT * FROM products WHERE barber_id = $1 ORDER BY name';
      params = [req.user.userId];
    } else if (req.user.role === 'owner') {
      // Owners see products for their shops (excluding barber-specific products)
      query = `
        SELECT p.*, s.name as shop_name
        FROM products p
        JOIN barbershops s ON p.shop_id = s.shop_id
        WHERE s.owner_id = $1 AND p.barber_id IS NULL
        ORDER BY s.name, p.name
      `;
      params = [req.user.userId];
    }
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching my products:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new product (barber or owner)
router.post('/', authenticateToken, authorizeRoles('barber', 'owner'), async (req, res) => {
  const { name, description, price, stock, photoUrl, category, shopId, offer } = req.body;
  
  try {
    let barberId = null;
    let finalShopId = shopId;
    
    if (req.user.role === 'barber') {
      barberId = req.user.userId;
      
      // If no shop ID provided, get barber's shop
      if (!finalShopId) {
        const barberResult = await pool.query(
          'SELECT shop_id FROM users WHERE user_id = $1',
          [req.user.userId]
        );
        
        finalShopId = barberResult.rows[0]?.shop_id;
      }
    } else if (req.user.role === 'owner') {
      // Check if owner owns this shop
      const shopCheck = await pool.query(
        'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
        [finalShopId, req.user.userId]
      );
      
      if (shopCheck.rows.length === 0) {
        return res.status(403).json({ message: 'You do not own this shop' });
      }
    }
    
    const result = await pool.query(`
      INSERT INTO products 
      (name, description, price, stock, photo_url, category, shop_id, barber_id, offer)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [name, description, price, stock, photoUrl, category, finalShopId, barberId, offer]);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a product (barber or owner)

router.put('/:id', authenticateToken, authorizeRoles('barber', 'owner'), async (req, res) => {
  const { name, description, price, stock, photoUrl, category, offer } = req.body;
  const productId = req.params.id;
  
  try {
    // Check authorization
    let authorized = false;
    
    if (req.user.role === 'barber') {
      // Check if product belongs to barber
      const productCheck = await pool.query(
        'SELECT * FROM products WHERE product_id = $1 AND barber_id = $2',
        [productId, req.user.userId]
      );
      
      authorized = productCheck.rows.length > 0;
    } else if (req.user.role === 'owner') {
      // Check if product is in owner's shop
      const productCheck = await pool.query(`
        SELECT p.* FROM products p
        JOIN barbershops s ON p.shop_id = s.shop_id
        WHERE p.product_id = $1 AND s.owner_id = $2 AND p.barber_id IS NULL
      `, [productId, req.user.userId]);
      
      authorized = productCheck.rows.length > 0;
    }
    
    if (!authorized) {
      return res.status(403).json({ message: 'Not authorized to update this product' });
    }

    // Obtener la foto anterior
    const prevResult = await pool.query(
      'SELECT photo_url FROM products WHERE product_id = $1',
      [productId]
    );
    const prevUrl = prevResult.rows[0]?.photo_url;

    // Update product
    const result = await pool.query(`
      UPDATE products 
      SET name = $1, description = $2, price = $3, stock = $4, 
          photo_url = $5, category = $6, offer = $7, updated_at = NOW()
      WHERE product_id = $8
      RETURNING *
    `, [name, description, price, stock, photoUrl, category, offer, productId]);

    // Si cambia la foto y la anterior era local, la borra
    if (prevUrl && prevUrl !== photoUrl && prevUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../../../', prevUrl);
      fs.unlink(filePath, (err) => {
        if (err) console.error('No se pudo borrar la foto anterior del producto:', err);
        else console.log(`Foto antigua eliminada: ${filePath}`);
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a product (barber or owner)
router.delete('/:id', authenticateToken, authorizeRoles('barber', 'owner'), async (req, res) => {
  const productId = req.params.id;
  
  try {
    // Check authorization
    let authorized = false;
    let productData = null;
    
    // Obtener datos del producto, incluida la URL de la imagen
    const productResult = await pool.query(
      'SELECT * FROM products WHERE product_id = $1',
      [productId]
    );
    
    if (productResult.rows.length === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    
    productData = productResult.rows[0];
    
    if (req.user.role === 'barber') {
      // Check if product belongs to barber
      authorized = productData.barber_id === req.user.userId;
    } else if (req.user.role === 'owner') {
      // Check if product is in owner's shop
      const shopCheck = await pool.query(`
        SELECT * FROM barbershops 
        WHERE shop_id = $1 AND owner_id = $2
      `, [productData.shop_id, req.user.userId]);
      
      authorized = shopCheck.rows.length > 0 && !productData.barber_id;
    }
    
    if (!authorized) {
      return res.status(403).json({ message: 'No está autorizado para eliminar este producto' });
    }
    
    // Eliminar la imagen si existe y es local
    const photoUrl = productData.photo_url;
    if (photoUrl && photoUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../../../', photoUrl);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('Error al eliminar la imagen del producto:', err);
          // Continuamos con la eliminación del producto aunque falle la eliminación de la imagen
        } else {
          console.log(`Imagen del producto eliminada: ${filePath}`);
        }
      });
    }
    
    // Delete product from database
    await pool.query('DELETE FROM products WHERE product_id = $1', [productId]);
    
    res.json({ 
      message: 'Producto eliminado correctamente',
      deletedImage: photoUrl && photoUrl.startsWith('/uploads/') ? photoUrl : null
    });
  } catch (error) {
    console.error('Error al eliminar el producto:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Register a product sale (barber or owner)
router.post('/:id/sale', authenticateToken, authorizeRoles('barber', 'owner'), async (req, res) => {
  const { quantity } = req.body;
  const productId = req.params.id;
  
  try {
    // Get product details
    const productResult = await pool.query('SELECT * FROM products WHERE product_id = $1', [productId]);
    
    if (productResult.rows.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }
    
    const product = productResult.rows[0];
    
    // Check authorization
    let authorized = false;
    let barberId = null;
    
    if (req.user.role === 'barber') {
      // Barbers can sell their own products or shop products where they work
      if (product.barber_id === req.user.userId) {
        authorized = true;
        barberId = req.user.userId;
      } else {
        // Check if barber works in the shop
        const barberShopCheck = await pool.query(
          'SELECT * FROM users WHERE user_id = $1 AND shop_id = $2',
          [req.user.userId, product.shop_id]
        );
        
        authorized = barberShopCheck.rows.length > 0;
        barberId = req.user.userId;
      }
    } else if (req.user.role === 'owner') {
      // Owners can sell products in their shops
      const shopCheck = await pool.query(
        'SELECT * FROM barbershops WHERE shop_id = $1 AND owner_id = $2',
        [product.shop_id, req.user.userId]
      );
      
      authorized = shopCheck.rows.length > 0;
    }
    
    if (!authorized) {
      return res.status(403).json({ message: 'Not authorized to sell this product' });
    }
    
    // Check if enough stock
    if (product.stock < quantity) {
      return res.status(400).json({ message: 'Not enough stock available' });
    }
    
    // Start transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Update stock
      await client.query(
        'UPDATE products SET stock = stock - $1 WHERE product_id = $2',
        [quantity, productId]
      );
      
      // Record sale
      await client.query(
        'INSERT INTO productsales (product_id, quantity, shop_id, barber_id) VALUES ($1, $2, $3, $4)',
        [productId, quantity, product.shop_id, barberId]
      );
      
      await client.query('COMMIT');
      
      res.json({ message: 'Sale registered successfully' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error registering sale:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;