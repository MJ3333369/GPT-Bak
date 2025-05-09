const express = require("express");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require('uuid');
const { connectToDB } = require("./db");
require("dotenv").config();
const OpenAI = require("openai");
const oracledb = require("oracledb");
oracledb.fetchAsString = [oracledb.CLOB];

const app = express();
const port = process.env.PORT || 3000;

const helmet = require("helmet");
app.use(helmet());

app.use(express.static("public"));
app.use(express.json());


// Rate limiter – max 100 pieprasījumi 15 minūtēs no vienas IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Pārāk daudz pieprasījumu no šīs IP. Mēģini vēlreiz pēc 15 minūtēm.'
});
app.use('/api', apiLimiter);


let dbAvailable = true;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function validateRequestBody(body) {
  const { messages, languageInput, userId, sessionId, topic } = body;
  if (messages) {
    if (!Array.isArray(messages)) return 'messages jābūt masīvam.';
    for (const msg of messages) {
      if (typeof msg.role !== 'string' || typeof msg.content !== 'string') return 'Katrā message jābūt role un content kā tekstam.';
    }
  }
  if (languageInput && typeof languageInput !== 'string') return 'languageInput jābūt tekstam.';
  if (userId && typeof userId !== 'string') return 'userId jābūt tekstam.';
  if (sessionId && typeof sessionId !== 'string') return 'sessionId jābūt tekstam.';
  if (topic && typeof topic !== 'string') return 'topic jābūt tekstam.';
  return null;
}

async function withDB(callback) {
  let db;
  try {
    console.log("🟢 [withDB] Mēģinu izveidot savienojumu ar DB...");
    db = await connectToDB();
    console.log("✅ [withDB] Savienojums izveidots, izpildu callback...");
    await callback(db);
    await db.commit();
    console.log("✅ [withDB] Commit izpildīts.");
  } catch (err) {
    console.error("❌ [withDB] Savienojums ar DB neizdevās:", err);
    dbAvailable = false;
    throw err;
  } finally {
    if (db) {
      await db.close();
      console.log("🔒 [withDB] Savienojums ar DB aizvērts.");
    }
  }
}


async function saveMessage(db, sessionId, role, content) {
  await db.execute(
    `INSERT INTO MESSAGES (Message_ID, Session_ID, Role, Content, Created_At)
     VALUES (:msg_id, :session_id, :role, :content, SYSTIMESTAMP)`,
    { msg_id: uuidv4(), session_id: sessionId, role, content }
  );
}

// Start session
app.post("/api/start-session", async (req, res) => {
  console.log("📥 [API] /api/start-session pieprasījums saņemts ar body:", req.body);
  const validationError = validateRequestBody(req.body);
  if (validationError) return res.status(400).json({ error: `Datu validācijas kļūda: ${validationError}` });

  const { userId, languageInput, topic } = req.body;
  const newSessionId = uuidv4();

  try {
    if (dbAvailable) {
      await withDB(async (db) => {
        console.log("➡️ [start-session] Izpildu MERGE INTO USERS...");
        await db.execute(
          `MERGE INTO USERS u USING dual ON (u.User_ID = :user_id)
           WHEN NOT MATCHED THEN INSERT (User_ID, Language, Topic)
           VALUES (:user_id, :language, :topic)
           WHEN MATCHED THEN UPDATE SET Language = :language, Topic = :topic`,
          { user_id: userId, language: languageInput, topic }
        );
        console.log("✅ [start-session] MERGE INTO USERS izpildīts.");

        console.log("➡️ [start-session] Izpildu INSERT INTO SESSIONS...");
        await db.execute(
          `INSERT INTO SESSIONS (Session_ID, User_ID, Created_At) VALUES (:session_id, :user_id, SYSTIMESTAMP)`,
          { session_id: newSessionId, user_id: userId }
        );
        console.log("✅ [start-session] INSERT INTO SESSIONS izpildīts.");
      });
    }
    res.json({ sessionId: newSessionId, mode: dbAvailable ? "online" : "offline" });
  } catch (err) {
    console.error("Kļūda /api/start-session:", err);
    res.json({ sessionId: newSessionId, mode: "offline" });
  }
});

// Load last session + masteredTopics
app.post("/api/load-session", async (req, res) => {
  console.log("📥 [API] /api/load-session pieprasījums saņemts ar body:", req.body);
  const { userId } = req.body;
  if (typeof userId !== 'string') return res.status(400).json({ error: 'userId jābūt tekstam.' });

  try {
    if (dbAvailable) {
      let sessionId, userInfo, messages, masteredTopics = [];
      await withDB(async (db) => {
        const sessionRes = await db.execute(
          `SELECT Session_ID FROM SESSIONS WHERE User_ID = :user_id ORDER BY Created_At DESC FETCH FIRST 1 ROWS ONLY`,
          { user_id: userId }
        );
        if (sessionRes.rows.length === 0) return res.json({ messages: [], mode: "online", masteredTopics: [] });

        sessionId = sessionRes.rows[0][0];

        const messagesRes = await db.execute(
          `SELECT Role, Content FROM MESSAGES WHERE Session_ID = :session_id ORDER BY Created_At`,
          { session_id: sessionId }
        );
        const userRes = await db.execute(
          `SELECT Language, Topic FROM USERS WHERE User_ID = :user_id`,
          { user_id: userId }
        );
        const progressRes = await db.execute(
          `SELECT Topic FROM PROGRESS WHERE User_ID = :user_id AND Mastered = 1`,
          { user_id: userId }
        );

        userInfo = userRes.rows[0];
        messages = messagesRes.rows.map(row => ({ role: String(row[0]), content: String(row[1]) }));
        masteredTopics = progressRes.rows.map(row => row[0]);
      });

      res.json({
        messages,
        language: userInfo[0],
        topic: userInfo[1],
        sessionId,
        masteredTopics,
        mode: "online"
      });
    } else {
      res.json({ messages: [], mode: "offline", masteredTopics: [] });
    }
  } catch (err) {
    console.error("Sesijas ielādes kļūda:", err);
    res.json({ messages: [], mode: "offline", masteredTopics: [] });
  }
});

// Chat endpoint
app.post("/api/chat", async (req, res) => {
  console.log("📥 [API] /api/chat pieprasījums saņemts ar body:", req.body);
  const validationError = validateRequestBody(req.body);
  if (validationError) return res.status(400).json({ error: `Datu validācijas kļūda: ${validationError}` });

  const { messages, languageInput, userId, sessionId, topic } = req.body;

  let masteredTopics = [];
  let isCurrentTopicMastered = false;

  if (dbAvailable) {
    try {
      await withDB(async (db) => {
        const progressRes = await db.execute(
          `SELECT Topic FROM PROGRESS WHERE User_ID = :user_id AND Mastered = 1`,
          { user_id: userId }
        );
        masteredTopics = progressRes.rows.map(row => row[0]);
        isCurrentTopicMastered = masteredTopics.includes(topic);
      });
    } catch (err) {
      console.error("Kļūda iegūstot apgūtās tēmas:", err);
    }
  }

// Tēmu saistību kartējums
const topicRelations = {
  "Breadth-First Search": ["Depth-First Search"],
  "Depth-First Search": ["Breadth-First Search"],
  "Minimax": ["Alpha-Beta"],
  "Alpha-Beta": ["Minimax"]
};

const related = topicRelations[topic] || [];
const relatedText = related.length > 0
  ? `\nNote: ${topic} is closely related to: ${related.join(', ')}. Feel free to reference or compare with these topics where appropriate.`
  : "";

isCurrentTopicMastered = masteredTopics.includes(topic);

const masteredText = masteredTopics.length > 0
  ? `The student has already mastered the following topics: ${masteredTopics.join(', ')}.` +
    (isCurrentTopicMastered
      ? ` The current topic (${topic}) is already mastered. Do NOT explain it again from scratch. Instead, offer comparisons, deeper insights, or advanced questions to challenge understanding.`
      : ` Since ${topic} may be related to some mastered topics, you are encouraged to explain it by comparing with those mastered topics, focusing on differences, nuances, and what is new.`)
  : `The student has not yet mastered any topics.`;

const systemPrompt = `
${masteredText}${relatedText}

You are a helpful and insightful virtual tutor specialized in ${topic}.
You are allowed to reference or compare with any of the mastered topics (${masteredTopics.join(', ')}), even if they are not the current topic, to support deeper understanding.

IMPORTANT:
- If the student asks about ${topic} and it is already mastered, you MUST NOT explain ${topic} again from scratch.
- Instead, you should offer comparisons, ask advanced questions, or provide challenging exercises.
- If the student asks about other mastered topics, you may freely discuss them.
- If the student asks about unmastered topics, politely inform them they have not mastered those yet and suggest first covering ${topic}.

The student is learning in ${languageInput}.
Please explain everything in Latvian.

Your responsibilities:
- NEVER provide complete or runnable code.
- Focus on breaking down ${topic} concepts into logical steps.
- Encourage reflection with topic-specific or related-topic questions.
- Always tailor explanations based on the student's mastered knowledge.
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

// Generate test
app.post("/api/get-test", async (req, res) => {
  console.log("📥 [API] /api/get-test pieprasījums saņemts ar body:", req.body);
  const { topic, languageInput } = req.body;
  if (typeof topic !== 'string' || typeof languageInput !== 'string') return res.status(400).json({ error: 'Nepieciešami topic un languageInput kā teksts.' });

  try {
    const prompt = `Generate a 5-question multiple-choice test for the topic "${topic}" in programming language ${languageInput}.
Each question should have 4 random-shuffled options labeled A-D, and indicate which letter is correct.
Return only valid JSON: [{"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"correct":"B"}]
`;
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [{ role: "system", content: prompt }],
    });

    console.log("GPT raw response:", response.choices[0].message.content);
    try {
      const test = JSON.parse(response.choices[0].message.content);
      res.json({ test });
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      res.status(500).json({ error: "GPT atgrieza nederīgu JSON." });
    }
  } catch (error) {
    console.error("Kļūda ģenerējot testu:", error);
    res.status(500).json({ error: "Kļūda ģenerējot testu." });
  }
});

// Submit test
app.post("/api/submit-test", async (req, res) => {
  console.log("📥 [API] /api/submit-test pieprasījums saņemts ar body:", req.body);
  const { userId, topic, answers } = req.body;
  if (typeof userId !== 'string' || typeof topic !== 'string' || !Array.isArray(answers)) return res.status(400).json({ error: 'Nepieciešami userId, topic un answers.' });

  const correctCount = answers.filter(a => a.isCorrect).length;
  const total = answers.length;
  const passed = correctCount === total;

  if (passed && dbAvailable) {
    try {
      await withDB(async (db) => {
        await db.execute(
          `MERGE INTO PROGRESS p USING dual ON (p.User_ID = :user_id AND p.Topic = :topic)
           WHEN NOT MATCHED THEN INSERT (Progress_ID, User_ID, Topic, Mastered, Updated_At)
           VALUES (:progress_id, :user_id, :topic, 1, SYSTIMESTAMP)
           WHEN MATCHED THEN UPDATE SET Mastered = 1, Updated_At = SYSTIMESTAMP`,
          { progress_id: uuidv4(), user_id: userId, topic: topic }
        );
      });
    } catch (err) {
      console.error("Kļūda saglabājot progresu:", err);
    }
  }

  res.json({ result: passed ? "Passed" : "Failed", correct: correctCount, total });
});

app.listen(port, () => {
  console.log(`Serveris darbojas uz http://localhost:${port}`);
});
