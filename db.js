// db.js
require('dotenv').config();


const oracledb = require('oracledb');

async function connectToDB() {
  try {
    const connection = await oracledb.getConnection({
      user: process.env.DB_USERNAME, // jauztaisa cits lietotajs
      password: process.env.DB_PASSWORD, // šos vajag parlikt .env failā
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
