require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function connectToDB() {
  try {
    const client = await pool.connect();
    console.log("Savienojums ar PostgreSQL izdevās!");
    return client;
  } catch (err) {
    console.error("Kļūda savienojoties ar PostgreSQL:", err);
    throw err;
  }
}

module.exports = { connectToDB };
