const express = require("express");
const { v4: uuidv4 } = require('uuid');
const { connectToDB } = require("./db");
require("dotenv").config();
const OpenAI = require("openai");
const oracledb = require("oracledb");
oracledb.fetchAsString = [oracledb.CLOB];

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(express.json());

let dbAvailable = true;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const levelMap = {
  "1": "beginner",
  "2": "intermediate",
  "3": "advanced",
};

function validateRequestBody(body) {
  const { messages, levelNum, languageInput, userId, sessionId, topic } = body;

  if (messages) {
    if (!Array.isArray(messages)) {
      return 'messages jābūt masīvam.';
    }
    for (const msg of messages) {
      if (typeof msg.role !== 'string' || typeof msg.content !== 'string') {
        return 'Katrā message jābūt role un content kā tekstam.';
      }
    }
  }

  if (levelNum && isNaN(Number(levelNum))) {
    return 'levelNum jābūt skaitlim vai skaitliskai virknei.';
  }

  if (languageInput && typeof languageInput !== 'string') {
    return 'languageInput jābūt tekstam.';
  }

  if (userId && typeof userId !== 'string') {
    return 'userId jābūt tekstam.';
  }

  if (sessionId && typeof sessionId !== 'string') {
    return 'sessionId jābūt tekstam.';
  }

  if (topic && typeof topic !== 'string') {
    return 'topic jābūt tekstam.';
  }

  return null;
}

async function withDB(callback) {
  let db;
  try {
    db = await connectToDB();
    await callback(db);
    await db.commit();
  } catch (err) {
    console.error("Savienojums ar DB neizdevās:", err);
    dbAvailable = false;
    throw err;
  } finally {
    if (db) await db.close();
  }
}

async function saveMessage(db, sessionId, role, content) {
  await db.execute(
    `INSERT INTO MESSAGES (Message_ID, Session_ID, Role, Content)
     VALUES (:msg_id, :session_id, :role, :content)`,
    {
      msg_id: uuidv4(),
      session_id: sessionId,
      role,
      content
    }
  );
}

app.post("/api/start-session", async (req, res) => {
  const validationError = validateRequestBody(req.body);
  if (validationError) {
    return res.status(400).json({ error: `Datu validācijas kļūda: ${validationError}` });
  }

  const { userId, levelNum, languageInput, topic } = req.body;
  const level = levelMap[levelNum] || "beginner";
  const newSessionId = uuidv4();

  try {
    if (dbAvailable) {
      await withDB(async (db) => {
        await db.execute(
          `MERGE INTO USERS u USING dual ON (u.User_ID = :user_id)
           WHEN NOT MATCHED THEN INSERT (User_ID, knowledge_level, Language, Topic)
           VALUES (:user_id, :knowledge_level, :language, :topic)
           WHEN MATCHED THEN UPDATE SET knowledge_level = :knowledge_level, Language = :language, Topic = :topic`,
          { user_id: userId, knowledge_level: level, language: languageInput, topic }
        );
        await db.execute(
          `INSERT INTO SESSIONS (Session_ID, User_ID) VALUES (:session_id, :user_id)`,
          { session_id: newSessionId, user_id: userId }
        );
      });
    }
    res.json({ sessionId: newSessionId, mode: dbAvailable ? "online" : "offline" });
  } catch (err) {
    console.error("Kļūda /api/start-session:", err);
    res.json({ sessionId: newSessionId, mode: "offline" });
  }
});

app.post("/api/load-session", async (req, res) => {
  const { userId } = req.body;

  if (typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId jābūt tekstam.' });
  }

  try {
    if (dbAvailable) {
      let sessionId, userInfo, messages;
      await withDB(async (db) => {
        const sessionRes = await db.execute(
          `SELECT Session_ID FROM SESSIONS WHERE User_ID = :user_id ORDER BY CREATED_AT DESC FETCH FIRST 1 ROWS ONLY`,
          { user_id: userId }
        );

        if (sessionRes.rows.length === 0) {
          return res.json({ messages: [], mode: "online" });
        }

        sessionId = sessionRes.rows[0][0];

        const messagesRes = await db.execute(
          `SELECT Role, Content FROM MESSAGES WHERE Session_ID = :session_id ORDER BY CREATED_AT`,
          { session_id: sessionId }
        );

        const userRes = await db.execute(
          `SELECT knowledge_level, Language, Topic FROM USERS WHERE User_ID = :user_id`,
          { user_id: userId }
        );

        userInfo = userRes.rows[0];
        messages = messagesRes.rows.map(row => ({
          role: String(row[0]),
          content: String(row[1])
        }));
      });

      res.json({
        messages,
        level: userInfo[0],
        language: userInfo[1],
        topic: userInfo[2],
        sessionId,
        mode: "online"
      });
    } else {
      res.json({ messages: [], mode: "offline" });
    }
  } catch (err) {
    console.error("Sesijas ielādes kļūda:", err);
    res.json({ messages: [], mode: "offline" });
  }
});

app.post("/api/chat", async (req, res) => {
  const validationError = validateRequestBody(req.body);
  if (validationError) {
    return res.status(400).json({ error: `Datu validācijas kļūda: ${validationError}` });
  }

  const { messages, levelNum, languageInput, userId, sessionId, topic } = req.body;
  const level = levelMap[levelNum] || "beginner";

  const systemPrompt = `
You are a strict and focused virtual tutor specialized only in ${topic}, you must help the student to understand and to programm the specific algorithm.
Even if the student asks about other topics, you always bring the conversation back to ${topic}.
The student is at the ${level} level and learning in ${languageInput}.
Your responsibilities:
- NEVER provide complete or runnable code.
- Always focus on breaking down ${topic} concepts into simple, logical steps.
- Ask topic-specific questions before giving answers to encourage reflection.
- Stay strictly within ${topic} and help through guided thinking, not copying.
`;


  const fullMessages = [{ role: "system", content: systemPrompt }, ...messages];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: fullMessages,
    });
    const assistantReply = response.choices[0].message.content;

    if (dbAvailable) {
      try {
        await withDB(async (db) => {
          for (const message of messages) {
            await saveMessage(db, sessionId, message.role, message.content);
          }
          await saveMessage(db, sessionId, "assistant", assistantReply);
        });
        console.log("Ziņas saglabātas datubāzē");
      } catch (err) {
        console.error("Kļūda saglabājot ziņas:", err);
        dbAvailable = false;
      }
    }

    res.json({ reply: assistantReply, mode: dbAvailable ? "online" : "offline" });
  } catch (error) {
    console.error("GPT kļūda:", error);
    res.json({ reply: "GPT kļūda: " + error.message, mode: dbAvailable ? "online" : "offline" });
  }
});

app.listen(port, () => {
  console.log(`Serveris darbojas uz http://localhost:${port}`);
});
