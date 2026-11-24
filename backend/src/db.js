const { Pool } = require('pg');

let poolConfig = {};

if (process.env.DATABASE_URL) {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL);
    poolConfig = {
      user: decodeURIComponent(dbUrl.username),
      password: decodeURIComponent(dbUrl.password),
      host: dbUrl.hostname,
      port: dbUrl.port ? parseInt(dbUrl.port, 10) : 5432,
      database: dbUrl.pathname.replace(/^\//, ''),
    };
    if (dbUrl.hostname.includes('render.com') || process.env.NODE_ENV === 'production' || process.env.DATABASE_URL.includes('sslmode=')) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  } catch (_e) {
    poolConfig = {
      connectionString: process.env.DATABASE_URL,
    };
    if (process.env.DATABASE_URL.includes('render.com') || process.env.NODE_ENV === 'production') {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  }
} else {
  poolConfig = {
    connectionString: 'postgres://attendance:VphLXYzMiig5VtuA0G8YQsJDtaQCSWMr@dpg-dbv7g72jnfac73crh4ig-a.singapore-postgres.render.com:5432/attendance_g2d6',
    ssl: { rejectUnauthorized: false }
  };
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected Postgres error on idle client', err);
});

module.exports = { pool };
