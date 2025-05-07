require('dotenv').config();

process.env.TNS_ADMIN = process.env.WALLET_DIR;  // ← ŠIS PIRMS initOracleClient

const oracledb = require('oracledb');
oracledb.initOracleClient({ libDir: 'C:/ORCLinstance/instantclient_19_26' });

async function connectToDB() {
  try {
    const connection = await oracledb.getConnection({
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      connectString: process.env.DB_CONNECT
    });

    console.log('Savienojums ar Oracle izdevās');
    return connection;
  } catch (err) {
    console.error('Savienojuma kļūda:', err);
    throw err;
  }
}

module.exports = { connectToDB };
