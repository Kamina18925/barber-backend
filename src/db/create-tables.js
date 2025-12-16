import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

// Cargar variables de entorno
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuración de la conexión
const config = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'barberia_rd',
  password: process.env.DB_PASSWORD || 'postgres',
  port: process.env.DB_PORT || 5432,
};

console.log('Configuración de conexión:', {
  user: config.user,
  host: config.host,
  database: config.database,
  port: config.port
});

async function createTables() {
  const client = new pg.Client(config);
  
  try {
    console.log('Conectando a la base de datos...');
    await client.connect();
    console.log('Conexión exitosa.');
    
    // Leer el archivo schema.sql
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    console.log('Ejecutando script de esquema...');
    await client.query(schemaSql);
    console.log('Esquema creado exitosamente.');
    
    // Verificar que las tablas se crearon
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    
    console.log('Tablas creadas:');
    tablesResult.rows.forEach(row => {
      console.log(`- ${row.table_name}`);
    });
    
    return true;
  } catch (error) {
    console.error('Error al crear tablas:', error);
    return false;
  } finally {
    await client.end();
    console.log('Conexión cerrada.');
  }
}

// Ejecutar la función si este archivo se ejecuta directamente
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createTables()
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

export default createTables;
