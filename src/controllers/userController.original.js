import pool from '../db/connection.js';
import bcrypt from 'bcrypt';

// Obtener todos los usuarios
export const getAllUsers = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name as nombre, email, phone as telefono, role
      FROM users
      ORDER BY name
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener usuarios:', error);
    res.status(500).json({ message: 'Error del servidor al obtener usuarios' });
  }
};

// Obtener usuario por ID
export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT id, name as nombre, email, phone as telefono, role
      FROM users
      WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener usuario por ID:', error);
    res.status(500).json({ message: 'Error del servidor al obtener usuario' });
  }
};

// Crear un nuevo usuario
export const createUser = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const {
      nombre,
      email,
      password,
      telefono,
      role
    } = req.body;
    
    // Verificar si el email ya existe
    const emailCheck = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (emailCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'El email ya está registrado' });
    }
    
    // Encriptar la contraseña
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // Insertar el usuario
    const result = await client.query(`
      INSERT INTO users (
        name, 
        email, 
        password,
        phone,
        role
      ) 
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name as nombre, email, phone as telefono, role
    `, [
      nombre,
      email,
      hashedPassword,
      telefono,
      role || 'client'
    ]);
    
    await client.query('COMMIT');
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear usuario:', error);
    res.status(500).json({ message: 'Error del servidor al crear usuario' });
  } finally {
    client.release();
  }
};

// Actualizar un usuario
export const updateUser = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const {
      nombre,
      email,
      password,
      telefono,
      direccion,
      role
    } = req.body;
    
    // Verificar que el usuario existe
    const checkResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    
    // Si se actualiza el email, verificar que no esté en uso por otro usuario
    if (email) {
      const emailCheck = await client.query('SELECT * FROM users WHERE email = $1 AND id != $2', [email, id]);
      
      if (emailCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'El email ya está registrado por otro usuario' });
      }
    }
    
    // Construir la consulta de actualización dinámicamente
    let updateQuery = 'UPDATE users SET ';
    const updateValues = [];
    let valueCounter = 1;
    
    if (nombre) {
      updateQuery += `nombre = $${valueCounter}, `;
      updateValues.push(nombre);
      valueCounter++;
    }
    
    if (email) {
      updateQuery += `email = $${valueCounter}, `;
      updateValues.push(email);
      valueCounter++;
    }
    
    if (password) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      updateQuery += `password = $${valueCounter}, `;
      updateValues.push(hashedPassword);
      valueCounter++;
    }
    
    if (telefono) {
      updateQuery += `telefono = $${valueCounter}, `;
      updateValues.push(telefono);
      valueCounter++;
    }
    
    if (direccion) {
      updateQuery += `direccion = $${valueCounter}, `;
      updateValues.push(direccion);
      valueCounter++;
    }
    
    if (role) {
      updateQuery += `role = $${valueCounter}, `;
      updateValues.push(role);
      valueCounter++;
    }
    
    // Añadir la fecha de actualización
    updateQuery += `updated_at = NOW() `;
    
    // Añadir la condición WHERE
    updateQuery += `WHERE id = $${valueCounter} `;
    updateValues.push(id);
    
    // Eliminar la coma extra si existe
    updateQuery = updateQuery.replace(', updated_at', ' updated_at');
    
    // Agregar RETURNING
    updateQuery += 'RETURNING id, uuid, nombre, email, telefono, direccion, role, created_at, updated_at';
    
    // Ejecutar la consulta de actualización
    const result = await client.query(updateQuery, updateValues);
    
    await client.query('COMMIT');
    
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar usuario:', error);
    res.status(500).json({ message: 'Error del servidor al actualizar usuario' });
  } finally {
    client.release();
  }
};

// Eliminar un usuario
export const deleteUser = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    
    // Verificar que el usuario existe
    const checkResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    
    // Eliminar el usuario
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    
    await client.query('COMMIT');
    
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar usuario:', error);
    res.status(500).json({ message: 'Error del servidor al eliminar usuario' });
  } finally {
    client.release();
  }
};

// Autenticar usuario
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Buscar el usuario por email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }
    
    const user = result.rows[0];
    
    // Verificar la contraseña
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }
    
    // Formatear la respuesta con los campos según el esquema real
    const userResponse = {
      id: user.id,
      nombre: user.name, // Mantenemos nombre en español para la respuesta al frontend
      email: user.email,
      telefono: user.phone, // Mantenemos telefono en español para la respuesta al frontend
      rol: user.role, // Mantenemos rol en español para la respuesta al frontend
      especialidades: user.specialties || [] // Mantenemos especialidades en español para la respuesta al frontend
    };
    
    res.json(userResponse);
  } catch (error) {
    console.error('Error al autenticar usuario:', error);
    res.status(500).json({ message: 'Error del servidor al autenticar usuario' });
  }
};
