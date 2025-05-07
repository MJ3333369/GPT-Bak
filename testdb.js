const oracledb = require('oracledb');
require('dotenv').config();
process.env.TNS_ADMIN = process.env.WALLET_DIR;
oracledb.initOracleClient({ libDir: 'C:/ORCLinstance/instantclient_19_26' });

(async function() {
  try {
    const conn = await oracledb.getConnection({
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      connectionString: process.env.DB_CONNECT
    });
    console.log("DB connection successful!");
    await conn.close();
  } catch (err) {
    console.error("DB connection error:", err);
  }
})();
