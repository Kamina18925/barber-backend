import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Create a new pool using environment variables
const host = process.env.DB_HOST || 'localhost';
const port = process.env.DB_PORT != null ? Number(process.env.DB_PORT) : 5432;
const database = process.env.DB_NAME || 'barberia_rd';
const user = process.env.DB_USER || 'postgres';
const password = process.env.DB_PASSWORD || 'postgres';

const isLocalHost = (value) => {
  const v = String(value || '').trim().toLowerCase();
  return v === 'localhost' || v === '127.0.0.1';
};

const dbSslFlag = String(process.env.DB_SSL || '').trim().toLowerCase();
const shouldUseSsl = dbSslFlag === 'false'
  ? false
  : dbSslFlag === 'true'
    ? true
    : !!process.env.DATABASE_URL
      ? true
      : !isLocalHost(host);

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
    }
  : {
      host,
      port,
      database,
      user,
      password,
    };

const pool = new Pool({
  ...poolConfig,
  ssl: shouldUseSsl ? { rejectUnauthorized: false } : undefined,
  max: process.env.DB_POOL_MAX != null
    ? Number(process.env.DB_POOL_MAX)
    : 10,
  keepAlive: process.env.DB_KEEP_ALIVE != null
    ? String(process.env.DB_KEEP_ALIVE).trim().toLowerCase() !== 'false'
    : true,
  keepAliveInitialDelayMillis: process.env.DB_KEEP_ALIVE_DELAY_MS != null
    ? Number(process.env.DB_KEEP_ALIVE_DELAY_MS)
    : 10000,
  connectionTimeoutMillis: process.env.DB_CONNECTION_TIMEOUT_MS != null
    ? Number(process.env.DB_CONNECTION_TIMEOUT_MS)
    : 15000,
  idleTimeoutMillis: process.env.DB_IDLE_TIMEOUT_MS != null
    ? Number(process.env.DB_IDLE_TIMEOUT_MS)
    : 30000,
});

console.log(
  '[DB] pool initialized:',
  JSON.stringify(
    {
      usingDatabaseUrl: !!process.env.DATABASE_URL,
      host,
      port,
      database,
      ssl: shouldUseSsl,
      max: pool.options?.max,
      keepAlive: pool.options?.keepAlive,
      keepAliveInitialDelayMillis: pool.options?.keepAliveInitialDelayMillis,
      connectionTimeoutMillis: pool.options?.connectionTimeoutMillis,
      idleTimeoutMillis: pool.options?.idleTimeoutMillis,
    },
    null,
    2
  )
);

pool.on('error', (error) => {
  console.error('[DB] Unexpected error on idle client:', error);
});

// Connect to the database
export const connectDB = async () => {
  try {
    const client = await pool.connect();
    console.log('Connected to PostgreSQL database');
    client.release();
    return pool;
  } catch (error) {
    console.error('Error connecting to database:', error);
    throw error;
  }
};

// Export the pool for use in other modules
export default pool;