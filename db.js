require('dotenv').config();

process.env.TNS_ADMIN = process.env.WALLET_DIR;  // ← ŠIS PIRMS initOracleClient

const oracledb = require('oracledb');

oracledb.initOracleClient({ libDir: 'C:/ORCLinstance/instantclient_19_26' });
console.log("Initializing OracleDB with libDir:", 'C:/ORCLinstance/instantclient_19_26');

console.log("✅ Oracle Client Initialized!");
console.log("TNS_ADMIN:", process.env.TNS_ADMIN);
console.log("PATH includes Instant Client?", process.env.PATH.includes("instantclient_19_26"));


async function connectToDB() {
  try {
    console.log('👉 Mēģinu izveidot savienojumu ar Oracle DB...');
    const connection = await oracledb.getConnection({
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      connectString: process.env.DB_CONNECT
    });
    console.log('Savienojums ar Oracle DB izdevās!');
    return connection;
  } catch (err) {
    console.error('Savienojuma kļūda ar Oracle DB:', err);
    throw err; // lai ar server.js var pamanīt
  }
}

if (require.main === module) {
  connectToDB().then(conn => conn.close());
}
module.exports = { connectToDB };