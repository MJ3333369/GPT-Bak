// db.js
const oracledb = require('oracledb');

async function connectToDB() {
  try {
    const connection = await oracledb.getConnection({
      user: 'SYSTEM', // jauztaisa cits lietotajs
      password: 'Alise135!', // šos vajag parlikt .env failā
      connectString: '90.133.122.121:1521/orcl'
    });
    console.log('Savienojums ar Oracle izdevās');
    return connection;
  } catch (err) {
    console.error('Savienojuma kļūda:', err);
    throw err;
  }
}
  
module.exports = { connectToDB };
