const express = require("express");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require('uuid');
const { connectToDB } = require("./db");
require("dotenv").config();
const fs = require('fs');
const path = require('path');
const OpenAI = require("openai");
const oracledb = require("oracledb");
oracledb.fetchAsString = [oracledb.CLOB];

const jsonPath = path.join(__dirname, 'public', 'topics.json');
const topicsData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
const allTopics = topicsData.topics.map(t => t.id);
const topicRelations = topicsData.relations;

const app = express();
const port = process.env.PORT || 3000;

const helmet = require("helmet");
app.use(helmet());
app.use(express.static("public"));
app.use(express.json());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Pārāk daudz pieprasījumu no šīs IP. Mēģini vēlreiz pēc 15 minūtēm.'
});
app.use('/api', apiLimiter);

let dbAvailable = true;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== PALĪGFUNKCIJAS =====

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
  if (topic && (typeof topic !== 'string' || !allTopics.includes(topic))) return `topic "${topic}" nav derīgs.`;
  return null;
}

async function withDB(callback) {
  let db;
  try {
    console.log("[withDB] Savienojos ar DB...");
    db = await connectToDB();
    await callback(db);
    await db.commit();
    console.log("[withDB] Commit izpildīts.");
  } catch (err) {
    console.error("[withDB] Kļūda:", err);
    dbAvailable = false;
    throw err;
  } finally {
    if (db) {
      await db.close();
      console.log("🔒 [withDB] Savienojums aizvērts.");
    }
  }
}

async function getMasteredTopics(userId, db) {
  const res = await db.execute(`SELECT Topic FROM PROGRESS WHERE User_ID = :user_id AND Mastered = 1`, { user_id: userId });
  return res.rows.map(row => row[0]);
}

async function getLastSession(userId, db) {
  const res = await db.execute(
    `SELECT Session_ID FROM SESSIONS WHERE User_ID = :user_id ORDER BY Created_At DESC FETCH FIRST 1 ROWS ONLY`,
    { user_id: userId }
  );
  return res.rows.length > 0 ? res.rows[0][0] : null;
}

async function saveMessagesBatch(db, sessionId, messages) {
  for (const msg of messages) {
    await db.execute(
      `INSERT INTO MESSAGES (Message_ID, Session_ID, Role, Content, Created_At)
       VALUES (:msg_id, :session_id, :role, :content, SYSTIMESTAMP)`,
      { msg_id: uuidv4(), session_id: sessionId, role: msg.role, content: msg.content }
    );
  }
}

function buildSystemPrompt(topic, languageInput, masteredTopics) {
  const isCurrentTopicMastered = masteredTopics.includes(topic);
  let masteryBlock = '';

  if (masteredTopics.length > 0) {
    masteryBlock = `
The student has already mastered the following topics: ${masteredTopics.join(', ')}.` +
      (isCurrentTopicMastered
        ? ` The current topic (${topic}) is already mastered. Do NOT explain it again from scratch. Instead, offer comparisons, deeper insights, or advanced questions to challenge understanding.`
        : ` Since ${topic} may be related to some mastered topics, you are encouraged to explain it by comparing with those mastered topics, focusing on differences, nuances, and what is new.`);

    masteryBlock += `

You are allowed to reference or compare with any of the mastered topics (${masteredTopics.join(', ')}), even if they are not the current topic, to support deeper understanding.
`;
  } else {
    masteryBlock = `
The student has not yet mastered any topics.
Do NOT assume prior knowledge of ${topic}.
Explain ${topic} from scratch, using beginner-friendly language and examples.
Avoid advanced explanations or comparisons to other topics.
`;
  }

  const related = topicRelations[topic] || [];
  const relatedText = related.length > 0
    ? `\nNote: ${topic} is closely related to: ${related.join(', ')}. Feel free to reference or compare with these topics where appropriate.`
    : "";

  const systemPrompt = `
${masteryBlock}${relatedText}

You are a helpful and insightful virtual tutor specialized in ${topic}.

IMPORTANT:
- If the student asks about ${topic} and it is already mastered, you MUST NOT explain ${topic} again from scratch.
- Instead, you should offer comparisons, ask advanced questions, or provide challenging exercises.
- If the student asks about other mastered topics, you may freely discuss them.
- If the student asks about unmastered topics, politely inform them they have not mastered those yet and suggest first covering ${topic}.

The student is learning in ${languageInput}.
Please explain everything in Latvian.

Your responsibilities:
- Always explain which type of search algorithm it is (uninformed or informed).
- Specify the category or class the algorithm belongs to (e.g., heuristic search, graph search).
- NEVER provide complete code solutions or fully runnable programs.
- You ARE allowed to provide pseudocode, partial code snippets, or code examples with intentional gaps or placeholders.
- Focus on helping the student understand how to write code step by step, explaining the logic and structure behind each part.
- You may comment on the student’s submitted code, suggest improvements, identify bugs, or explain unclear parts.
- Avoid handing out ready-to-use solutions, but always guide the student towards writing their own correct code.
- Encourage reflection with topic-specific or related-topic questions.
- Always tailor explanations based on the student's mastered knowledge.
`;

  return systemPrompt;
}

// ===== API =====

app.post("/api/start-session", async (req, res) => {
  console.log("📥 [API] /api/start-session:", req.body);
  const validationError = validateRequestBody(req.body);
  if (validationError) return res.status(400).json({ error: `Datu validācija: ${validationError}` });

  const { userId, languageInput, topic } = req.body;
  const newSessionId = uuidv4();

  try {
    if (dbAvailable) {
      await withDB(async (db) => {
        await db.execute(
          `MERGE INTO USERS u USING dual ON (u.User_ID = :user_id)
           WHEN NOT MATCHED THEN INSERT (User_ID, Language, Topic)
           VALUES (:user_id, :language, :topic)
           WHEN MATCHED THEN UPDATE SET Language = :language, Topic = :topic`,
          { user_id: userId, language: languageInput, topic }
        );
        await db.execute(
          `INSERT INTO SESSIONS (Session_ID, User_ID, Created_At) VALUES (:session_id, :user_id, SYSTIMESTAMP)`,
          { session_id: newSessionId, user_id: userId }
        );
      });
    }
    res.json({ sessionId: newSessionId, mode: dbAvailable ? "online" : "offline" });
  } catch (err) {
    console.error("/api/start-session kļūda:", err);
    res.json({ sessionId: newSessionId, mode: "offline" });
  }
});

app.post("/api/load-session", async (req, res) => {
  console.log("📥 [API] /api/load-session:", req.body);
  const { userId } = req.body;
  if (typeof userId !== 'string') return res.status(400).json({ error: 'userId jābūt tekstam.' });

  try {
    if (dbAvailable) {
      let sessionId, messages = [], masteredTopics = [], userInfo;
      await withDB(async (db) => {
        sessionId = await getLastSession(userId, db);
        if (!sessionId) {
          console.log(`[load-session] Nav sesijas userId: ${userId}`);
          return res.json({ messages: [], mode: "online", masteredTopics: [] });
        }

        const msgRes = await db.execute(`SELECT Role, Content FROM MESSAGES WHERE Session_ID = :session_id ORDER BY Created_At`, { session_id: sessionId });
        const userRes = await db.execute(`SELECT Language, Topic FROM USERS WHERE User_ID = :user_id`, { user_id: userId });

        if (userRes.rows.length === 0) {
          console.log(`[load-session] Nav ieraksta USERS tabulā priekš userId: ${userId}`);
          return res.json({ messages: [], mode: "online", masteredTopics: [] });
        }

        masteredTopics = await getMasteredTopics(userId, db);
        messages = msgRes.rows.map(row => ({ role: String(row[0]), content: String(row[1]) }));
        userInfo = userRes.rows[0];
      });

      res.json({ messages, language: userInfo[0], topic: userInfo[1], sessionId, masteredTopics, mode: "online" });
    } else {
      res.json({ messages: [], mode: "offline", masteredTopics: [] });
    }
  } catch (err) {
    console.error("/api/load-session kļūda:", err);
    res.json({ messages: [], mode: "offline", masteredTopics: [] });
  }
});


app.post("/api/chat", async (req, res) => {
  console.log("📥 [API] /api/chat:", req.body);
  const validationError = validateRequestBody(req.body);
  if (validationError) return res.status(400).json({ error: `Datu validācija: ${validationError}` });

  const { messages, languageInput, userId, sessionId, topic } = req.body;
  let masteredTopics = [];

  if (dbAvailable) {
    try {
      await withDB(async (db) => {
        masteredTopics = await getMasteredTopics(userId, db);
      });
    } catch (err) {
      console.error("Kļūda iegūstot masteredTopics:", err);
    }
  }

  const systemPrompt = buildSystemPrompt(topic, languageInput, masteredTopics);
  const fullMessages = [{ role: "system", content: systemPrompt }, ...messages];

  try {
    const response = await openai.chat.completions.create({ model: "gpt-4-turbo", messages: fullMessages });
    const assistantReply = response.choices[0].message.content;

    if (dbAvailable) {
      try {
        await withDB(async (db) => {
          await saveMessagesBatch(db, sessionId, messages);
          await saveMessagesBatch(db, sessionId, [{ role: "assistant", content: assistantReply }]);
        });
      } catch (err) {
        console.error("Kļūda saglabājot ziņas:", err);
        dbAvailable = false;
      }
    }

    res.json({ reply: assistantReply, mode: dbAvailable ? "online" : "offline" });
  } catch (err) {
    console.error("GPT kļūda:", err);
    res.json({ reply: "GPT kļūda: " + err.message, mode: dbAvailable ? "online" : "offline" });
  }
});

app.post("/api/get-test", async (req, res) => {
  console.log("[API] /api/get-test:", req.body);
  const { topic, languageInput } = req.body;
  if (typeof topic !== 'string' || typeof languageInput !== 'string') return res.status(400).json({ error: 'Nepieciešami topic un languageInput kā teksts.' });

  try {
    const prompt = `Lūdzu, izveido 5 jautājumu izvēles testu LATVIEŠU valodā par tēmu "${topic}" programmēšanas valodā ${languageInput}.
Katram jautājumam jābūt ar 4 atbildes variantiem (A, B, C, D) un jānorāda pareizā atbilde (burts).
Atgriez tikai JSON: [{"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"correct":"B"}]`;

    const response = await openai.chat.completions.create({ model: "gpt-4-turbo", messages: [{ role: "system", content: prompt }] });
    const test = JSON.parse(response.choices[0].message.content);
    res.json({ test });
  } catch (err) {
    console.error("Kļūda /api/get-test:", err);
    res.status(500).json({ error: "Kļūda ģenerējot testu vai parsējot JSON." });
  }
});

app.post("/api/submit-test", async (req, res) => {
  console.log("[API] /api/submit-test:", req.body);
  const { userId, topic, answers } = req.body;
  if (typeof userId !== 'string' || typeof topic !== 'string' || !Array.isArray(answers)) return res.status(400).json({ error: 'Nepieciešami userId, topic un answers.' });

  const correctCount = answers.filter(a => a.isCorrect).length;
  const passed = correctCount === answers.length;

  if (passed && dbAvailable) {
    try {
      await withDB(async (db) => {
        await db.execute(
          `MERGE INTO PROGRESS p USING dual ON (p.User_ID = :user_id AND p.Topic = :topic)
           WHEN NOT MATCHED THEN INSERT (Progress_ID, User_ID, Topic, Mastered, Updated_At)
           VALUES (:progress_id, :user_id, :topic, 1, SYSTIMESTAMP)
           WHEN MATCHED THEN UPDATE SET Mastered = 1, Updated_At = SYSTIMESTAMP`,
          { progress_id: uuidv4(), user_id: userId, topic }
        );
      });
    } catch (err) {
      console.error("Kļūda saglabājot progresu:", err);
    }
  }

  res.json({ result: passed ? "Passed" : "Failed", correct: correctCount, total: answers.length });
});

app.listen(port, () => {
  console.log(`Serveris darbojas uz http://localhost:${port}`);
});
