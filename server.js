const express = require("express");
const { v4: uuidv4 } = require('uuid');
const { connectToDB } = require("./db");
const path = require("path");
require("dotenv").config();
const OpenAI = require("openai");
const oracledb = require("oracledb");
oracledb.fetchAsString = [oracledb.CLOB];

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const levelMap = {
  "1": "beginner",
  "2": "intermediate",
  "3": "advanced",
};

async function withDB(callback) {
  const db = await connectToDB();
  try {
    await callback(db);
    await db.commit();
  } finally {
    await db.close();
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

// izveido sesiju tikai vienreiz sarunas sākumā
app.post("/api/start-session", async (req, res) => {
  const { userId, levelNum, languageInput } = req.body;
  const level = levelMap[levelNum] || "beginner";

  try {
    await withDB(async (db) => {
      await db.execute(
        `MERGE INTO USERS u
         USING dual
         ON (u.User_ID = :user_id)
         WHEN NOT MATCHED THEN
           INSERT (User_ID, knowledge_level, Language)
           VALUES (:user_id, :knowledge_level, :language)
         WHEN MATCHED THEN
           UPDATE SET knowledge_level = :knowledge_level, Language = :language`,
        {
          user_id: userId,
          knowledge_level: level,
          language: languageInput
        }
      );

      await db.execute(
        `INSERT INTO SESSIONS (Session_ID, User_ID)
         VALUES (:session_id, :user_id)`,
        {
          session_id: uuidv4(),
          user_id: userId
        }
      );
    });

    res.json({ sessionId: uuidv4() });
  } catch (err) {
    console.error("Kļūda /api/start-session:", err);
    res.status(500).json({ error: "Neizdevās izveidot sesiju" });
  }
});

//nosūta ziņu GPT un saglabā to esošajā sesijā
app.post("/api/chat", async (req, res) => {
  const { messages, levelNum, languageInput, userId, sessionId } = req.body;
  console.log("Saņemts POST uz /api/chat");
  console.log("Saņemtais userId:", userId);
  console.log("Esošā sesija:", sessionId);

  const level = levelMap[levelNum] || "beginner";

  const systemPrompt = `
You are a friendly and patient virtual tutor who helps students understand and implement search algorithms in artificial intelligence study course.

The student is at the ${level} level and currently learning ${languageInput}.
They may need help with topics such as uninformed search, heuristic search, game trees, or minimax algorithms.

Your goal is to help them become an independent problem solver by guiding them thoughtfully.

Your responsibilities:
- NEVER provide complete or runnable code that directly solves the student's task.
- Avoid using code formatting unless it's a generic or unrelated example.
- Focus on breaking down search algorithm concepts into simple, logical steps.
- Ask questions before giving answers to encourage reflection and problem solving.
- Help the student understand and implement algorithms through guided thinking, not copying.
`;

  const fullMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: fullMessages,
    });

    const assistantReply = response.choices[0].message.content;
    res.json({ reply: assistantReply });

    await withDB(async (db) => {
      for (const message of messages) {
        await saveMessage(db, sessionId, message.role, message.content);
      }
      await saveMessage(db, sessionId, "assistant", assistantReply);
    });

    console.log("Ziņas saglabātas datubāzē");
  } catch (error) {
    console.error("GPT vai ziņu saglabāšanas kļūda:", error);
    res.status(500).json({ error: "GPT kļūda", details: error.message });
  }
});

//ielādē pēdējo sesiju un ziņas
app.post("/api/load-session", async (req, res) => {
  const { userId } = req.body;

  try {
    await withDB(async (db) => {
      const sessionRes = await db.execute(
        `SELECT Session_ID
         FROM SESSIONS
         WHERE User_ID = :user_id
         ORDER BY CREATED_AT DESC FETCH FIRST 1 ROWS ONLY`,
        { user_id: userId }
      );

      if (sessionRes.rows.length === 0) {
        return res.json({ messages: [] });
      }

      const sessionId = sessionRes.rows[0][0];

      const messagesRes = await db.execute(
        `SELECT Role, Content
         FROM MESSAGES
         WHERE Session_ID = :session_id
         ORDER BY CREATED_AT`,
        { session_id: sessionId }
      );

      const userRes = await db.execute(
        `SELECT knowledge_level, Language FROM USERS WHERE User_ID = :user_id`,
        { user_id: userId }
      );

      const userInfo = userRes.rows[0];

      const messages = messagesRes.rows.map(row => ({
        role: String(row[0]),
        content: String(row[1])
      }));

      res.json({
        messages,
        level: userInfo[0],
        language: userInfo[1],
        sessionId
      });
    });
  } catch (err) {
    console.error("Sesijas ielādes kļūda:", err);
    res.status(500).json({ error: "Neizdevās ielādēt iepriekšējo sarunu" });
  }
});

app.listen(port, () => {
  console.log(`Serveris darbojas uz http://localhost:${port}`);
});
