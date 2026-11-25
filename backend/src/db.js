const { Pool } = require('pg');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres', 'db']);

let poolConfig = {
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

if (process.env.DATABASE_URL) {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL);
    poolConfig = {
      ...poolConfig,
      user: decodeURIComponent(dbUrl.username),
      password: decodeURIComponent(dbUrl.password),
      host: dbUrl.hostname,
      port: dbUrl.port ? parseInt(dbUrl.port, 10) : 5432,
      database: dbUrl.pathname.replace(/^\//, ''),
    };
    const isRemoteHost = !LOCAL_HOSTS.has(dbUrl.hostname);
    if (isRemoteHost || process.env.NODE_ENV === 'production' || process.env.DATABASE_URL.includes('sslmode=')) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  } catch (_e) {
    poolConfig = {
      ...poolConfig,
      connectionString: process.env.DATABASE_URL,
    };
    if (
      process.env.DATABASE_URL.includes('render.com') ||
      process.env.DATABASE_URL.includes('supabase.co') ||
      process.env.DATABASE_URL.includes('supabase.com') ||
      process.env.DATABASE_URL.includes('neon.tech') ||
      process.env.NODE_ENV === 'production'
    ) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  }
} else {
  poolConfig = {
    ...poolConfig,
    connectionString: 'postgres://attendance:VphLXYzMiig5VtuA0G8YQsJDtaQCSWMr@dpg-dbv7g72jnfac73crh4ig-a.singapore-postgres.render.com:5432/attendance_g2d6',
    ssl: { rejectUnauthorized: false }
  };
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected Postgres error on idle client', err);
});

module.exports = { pool };
