import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

// Cargar variables de entorno
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuración de la conexión a la base de datos
const { Pool } = pg;
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'barberia_rd',
  password: process.env.DB_PASSWORD || 'postgres',
  port: process.env.DB_PORT || 5432,
});

// Función para ejecutar un archivo SQL
async function executeSQL(filename) {
  try {
    const filePath = path.join(__dirname, filename);
    const sql = fs.readFileSync(filePath, 'utf8');
    
    console.log(`Ejecutando ${filename}...`);
    await pool.query(sql);
    console.log(`${filename} ejecutado con éxito.`);
    
    return true;
  } catch (error) {
    console.error(`Error al ejecutar ${filename}:`, error);
    return false;
  }
}

// Función principal para inicializar la base de datos
async function initializeDatabase() {
  try {
    console.log('Iniciando inicialización de la base de datos...');
    
    // Crear esquema
    const schemaResult = await executeSQL('schema.sql');
    if (!schemaResult) {
      throw new Error('Error al crear el esquema de la base de datos.');
    }
    
    // Insertar datos de ejemplo
    const seedResult = await executeSQL('seed.sql');
    if (!seedResult) {
      throw new Error('Error al insertar datos de ejemplo.');
    }
    
    console.log('Base de datos inicializada correctamente.');
    
    // Cerrar la conexión
    await pool.end();
    
    return true;
  } catch (error) {
    console.error('Error al inicializar la base de datos:', error);
    
    // Cerrar la conexión en caso de error
    try {
      await pool.end();
    } catch (err) {
      console.error('Error al cerrar la conexión:', err);
    }
    
    return false;
  }
}

// Ejecutar la inicialización si este archivo se ejecuta directamente
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initializeDatabase()
    .then(success => {
      if (success) {
        console.log('Proceso completado con éxito.');
        process.exit(0);
      } else {
        console.error('El proceso falló.');
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('Error inesperado:', error);
      process.exit(1);
    });
}

export default initializeDatabase;
