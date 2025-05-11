const { connectToDB } = require('./db');

(async () => {
  const client = await connectToDB();
  const res = await client.query('SELECT NOW()');
  console.log("Time now:", res.rows[0]);
  client.release();
})();
