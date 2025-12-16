import pool from '../db/connection.js';
import { v4 as uuidv4 } from 'uuid';

// Obtener todos los productos
export const getAllProducts = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id, 
        p.uuid, 
        p.name, 
        p.description, 
        p.price, 
        p.discount_price,
        p.stock, 
        p.shop_id, 
        p.barber_id,
        u.name as barber_name, 
        bs.name as shop_name,
        p.image_url,
        p.created_at
      FROM products p
      LEFT JOIN users u ON p.barber_id = u.id
      LEFT JOIN barber_shops bs ON p.shop_id = bs.id
      ORDER BY p.name
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(500).json({ message: 'Error del servidor al obtener productos' });
  }
};

// Obtener productos por tienda
export const getProductsByShop = async (req, res) => {
  try {
    const { shopId } = req.params;

    const result = await pool.query(
      `SELECT id, uuid, name, description, price, discount_price, stock, shop_id, barber_id, image_url
       FROM products
       WHERE shop_id = $1
       ORDER BY name`,
      [shopId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener productos por tienda:', error);
    res.status(500).json({ message: 'Error del servidor al obtener productos por tienda' });
  }
};

export const getProductsByBarber = async (req, res) => {
  try {
    const { barberId } = req.params;

    const result = await pool.query(
      `SELECT id, uuid, name, description, price, discount_price, stock, shop_id, barber_id, image_url
       FROM products
       WHERE barber_id = $1
       ORDER BY name`,
      [barberId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener productos por barbero:', error);
    res.status(500).json({ message: 'Error del servidor al obtener productos por barbero' });
  }
};

// Obtener producto por ID
export const getProductById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT id, uuid, name, description, price, discount_price, stock, shop_id, image_url
       FROM products
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener producto por ID:', error);
    res.status(500).json({ message: 'Error del servidor al obtener producto' });
  }
};

// Crear un nuevo producto
export const createProduct = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const productData = req.body.productData || req.body;

    console.log('createProduct - cuerpo recibido:', productData);

    // Aceptar varios nombres de campos desde el frontend
    const {
      name,
      description,
      price,
      offer,
      stock,
      photoUrl,
      imageUrl,
      image_url,
      shopId,
      shop_id,
      barberId,
      barber_id
    } = productData;

    const finalName = name;
    const finalPrice = price !== undefined && price !== null ? Number(price) : null;
    const finalDiscount = offer !== undefined && offer !== null ? Number(offer) : null;
    const finalStock = stock !== undefined && stock !== null ? Number(stock) : 0;
    const finalShopId = shopId !== undefined ? shopId : (shop_id !== undefined ? shop_id : null);
    const finalImageUrl = imageUrl || image_url || photoUrl || null;
    const finalBarberId = barberId !== undefined ? barberId : (barber_id !== undefined ? barber_id : null);

    // Validaciones básicas
    if (!finalName || finalName.trim() === '') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El nombre del producto es obligatorio' });
    }

    if (finalPrice === null || Number.isNaN(finalPrice)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El precio del producto es obligatorio y debe ser numérico' });
    }

    // shop_id puede ser NULL (producto sin barbería asociada) o un id válido

    const uuid = uuidv4();

    const result = await client.query(
      `INSERT INTO products (
        uuid,
        name,
        description,
        price,
        discount_price,
        stock,
        shop_id,
        barber_id,
        image_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, uuid, name, description, price, discount_price, stock, shop_id, barber_id, image_url`,
      [
        uuid,
        finalName,
        description || null,
        finalPrice,
        finalDiscount,
        finalStock,
        finalShopId,
        finalBarberId,
        finalImageUrl
      ]
    );

    await client.query('COMMIT');

    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear producto:', error);
    res.status(500).json({ message: 'Error del servidor al crear producto', detalle: error.message });
  } finally {
    client.release();
  }
};

// Actualizar un producto
export const updateProduct = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    // Permitir que el cuerpo venga como { productData } o plano
    const body = req.body.productData || req.body;

    console.log('updateProduct - cuerpo recibido:', body);

    const {
      // Variantes en inglés/español
      name,
      nombre,
      description,
      descripcion,
      price,
      precio,
      offer,
      oferta,
      stock,
      photoUrl,
      imageUrl,
      image_url,
      shopId,
      shop_id,
      barberId,
      barber_id
    } = body;

    const finalName = name || nombre;
    const finalPriceRaw = price !== undefined ? price : precio;
    const finalPrice = finalPriceRaw !== undefined && finalPriceRaw !== null ? Number(finalPriceRaw) : null;
    const finalDiscountRaw = offer !== undefined ? offer : oferta;
    const finalDiscount = finalDiscountRaw !== undefined && finalDiscountRaw !== null && finalDiscountRaw !== ''
      ? Number(finalDiscountRaw)
      : null;
    const finalStock = stock !== undefined && stock !== null ? Number(stock) : null;
    const finalShopId = shopId !== undefined ? shopId : (shop_id !== undefined ? shop_id : null);
    const finalImageUrl = imageUrl || image_url || photoUrl || null;
    const finalBarberId = barberId !== undefined ? barberId : (barber_id !== undefined ? barber_id : null);

    // Validaciones básicas
    if (!finalName || finalName.trim() === '') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El nombre del producto es obligatorio' });
    }

    if (finalPrice === null || Number.isNaN(finalPrice)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El precio del producto es obligatorio y debe ser numérico' });
    }

    // Verificar que el producto existe
    const checkResult = await client.query('SELECT * FROM products WHERE id = $1', [id]);

    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    const existing = checkResult.rows[0];

    // Actualizar el producto
    const result = await client.query(
      `UPDATE products 
       SET 
         name = $1,
         description = $2,
         price = $3,
         discount_price = $4,
         stock = $5,
         shop_id = $6,
         barber_id = $7,
         image_url = $8,
         updated_at = NOW()
       WHERE id = $9
       RETURNING id, uuid, name, description, price, discount_price, stock, shop_id, barber_id, image_url, created_at, updated_at`,
      [
        finalName,
        description !== undefined ? description : (descripcion !== undefined ? descripcion : existing.description),
        finalPrice,
        finalDiscount,
        finalStock !== null ? finalStock : existing.stock,
        finalShopId,
        finalBarberId,
        finalImageUrl,
        id
      ]
    );

    await client.query('COMMIT');

    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar producto:', error);
    res.status(500).json({ message: 'Error del servidor al actualizar producto', detalle: error.message });
  } finally {
    client.release();
  }
};

// Eliminar un producto
export const deleteProduct = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    
    // Verificar que el producto existe
    const checkResult = await client.query('SELECT * FROM products WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    
    // Eliminar el producto
    await client.query('DELETE FROM products WHERE id = $1', [id]);
    
    await client.query('COMMIT');
    
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar producto:', error);
    res.status(500).json({ message: 'Error del servidor al eliminar producto' });
  } finally {
    client.release();
  }
};
