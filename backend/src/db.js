const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  // Idle client errors shouldn't crash the whole process.
  console.error('Unexpected Postgres error on idle client', err);
});

module.exports = { pool };
