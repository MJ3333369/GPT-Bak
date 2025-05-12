// server.js - PostgreSQL versija

const express = require("express");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require('uuid');
const { connectToDB } = require("./db");
require("dotenv").config();
const fs = require('fs');
const path = require('path');
const OpenAI = require("openai");

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

const userRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minūtes
  max: 3, // max 30 pieprasījumi vienam lietotājam 10 minūtēs
  keyGenerator: (req) => {
    return req.body?.userId || req.ip; // izmanto userId, ja pieejams
  },
  message: 'Pārāk daudz pieprasījumu no šī lietotāja. Mēģini vēlreiz pēc 10 minūtēm.'
});

let dbAvailable = true;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  const db = await connectToDB();
  try {
    await callback(db);
  } finally {
    db.release();
  }
}

async function getMasteredTopics(userId, db) {
  const res = await db.query(`SELECT Topic FROM PROGRESS WHERE User_ID = $1 AND Mastered = true`, [userId]);
  return res.rows.map(row => row.topic);
}

async function getLastSession(userId, db) {
  const res = await db.query(`SELECT Session_ID FROM SESSIONS WHERE User_ID = $1 ORDER BY Created_At DESC LIMIT 1`, [userId]);
  return res.rows.length > 0 ? res.rows[0].session_id : null;
}

async function saveMessagesBatch(db, sessionId, messages) {
  for (const msg of messages) {
    await db.query(
      `INSERT INTO MESSAGES (Message_ID, Session_ID, Role, Content, Created_At)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [uuidv4(), sessionId, msg.role, msg.content]
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
              : ` Although ${topic} is related to some mastered topics, it has NOT been mastered yet. Therefore, you must still explain it clearly and from scratch, but you may use comparisons to known topics like (${masteredTopics.join(', ')}) to aid understanding.`);

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
    const knownRelated = related.filter(t => masteredTopics.includes(t));
    const unknownRelated = related.filter(t => !masteredTopics.includes(t));

    let relatedText = '';

    if (knownRelated.length > 0) {
      relatedText += `
      The current topic (${topic}) is closely related to the following mastered topics: ${knownRelated.join(', ')}.
      You MUST actively use these mastered topics (${knownRelated.join(', ')}) to support the explanation.
      Use comparisons, analogies, references or transitions from these known topics to explain new concepts.`;
    }

    if (unknownRelated.length > 0) {
      relatedText += `
      DO NOT assume the student knows the following related topics: ${unknownRelated.join(', ')}.
      Avoid referencing or comparing with these topics unless the student explicitly asks.`;
    }

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


app.post("/api/start-session", async (req, res) => {
  console.log("[API] /api/start-session:", req.body);
  const validationError = validateRequestBody(req.body);
  if (validationError) return res.status(400).json({ error: `Datu validācija: ${validationError}` });

  const { userId, languageInput, topic } = req.body;
  const newSessionId = uuidv4();

  try {
    await withDB(async (db) => {
      await db.query(
        `INSERT INTO USERS (User_ID, Language, Topic)
         VALUES ($1, $2, $3)
         ON CONFLICT (User_ID) DO UPDATE SET Language = EXCLUDED.Language, Topic = EXCLUDED.Topic`,
        [userId, languageInput, topic]
      );
      await db.query(`INSERT INTO SESSIONS (Session_ID, User_ID, Created_At) VALUES ($1, $2, CURRENT_TIMESTAMP)`, [newSessionId, userId]);
    });
    res.json({ sessionId: newSessionId, mode: "online" });
  } catch (err) {
    console.error("/api/start-session kļūda:", err);
    dbAvailable = false;
    res.json({ sessionId: newSessionId, mode: "offline" });
  }
});

app.post("/api/load-session", async (req, res) => {
  console.log("[API] /api/load-session:", req.body);
  const { userId } = req.body;
  if (typeof userId !== 'string') return res.status(400).json({ error: 'userId jābūt tekstam.' });

  try {
    let sessionId, messages = [], masteredTopics = [], userInfo;
    await withDB(async (db) => {
      sessionId = await getLastSession(userId, db);
      if (!sessionId) return res.json({ messages: [], mode: "online", masteredTopics: [] });

      const msgRes = await db.query(`SELECT Role, Content FROM MESSAGES WHERE Session_ID = $1 ORDER BY Created_At`, [sessionId]);
      const userRes = await db.query(`SELECT Language, Topic FROM USERS WHERE User_ID = $1`, [userId]);

      if (userRes.rows.length === 0) return res.json({ messages: [], mode: "online", masteredTopics: [] });

      masteredTopics = await getMasteredTopics(userId, db);
      messages = msgRes.rows.map(row => ({ role: row.role, content: row.content }));
      userInfo = userRes.rows[0];
    });

    res.json({ messages, language: userInfo.language, topic: userInfo.topic, sessionId, masteredTopics, mode: "online" });
  } catch (err) {
    console.error("/api/load-session kļūda:", err);
    res.json({ messages: [], mode: "offline", masteredTopics: [] });
  }
});

app.post("/api/chat", userRateLimiter, async (req, res) => {
  console.log("[API] /api/chat:", req.body);
  const validationError = validateRequestBody(req.body);
  if (validationError) return res.status(400).json({ error: `Datu validācija: ${validationError}` });

  const { messages, languageInput, userId, sessionId, topic } = req.body;
  let masteredTopics = [];

  try {
    await withDB(async (db) => {
      masteredTopics = await getMasteredTopics(userId, db);
    });
  } catch (err) {
    console.error("Kļūda iegūstot masteredTopics:", err);
    dbAvailable = false;
  }

  const systemPrompt = buildSystemPrompt(topic, languageInput, masteredTopics);
  const fullMessages = [{ role: "system", content: systemPrompt }, ...messages];

  try {
    const response = await openai.chat.completions.create({ model: "gpt-4-turbo", messages: fullMessages });
    const assistantReply = response.choices[0].message.content;

    try {
      await withDB(async (db) => {
        await saveMessagesBatch(db, sessionId, messages);
        await saveMessagesBatch(db, sessionId, [{ role: "assistant", content: assistantReply }]);
      });
    } catch (err) {
      console.error("Kļūda saglabājot ziņas:", err);
      dbAvailable = false;
    }

    res.json({ reply: assistantReply, mode: dbAvailable ? "online" : "offline" });
  } catch (err) {
    console.error("GPT kļūda:", err);
    res.json({ reply: "GPT kļūda: " + err.message, mode: dbAvailable ? "online" : "offline" });
  }
});

app.post("/api/get-test", userRateLimiter, async (req, res) => {
  console.log("[API] /api/get-test:", req.body);
  const { topic, languageInput } = req.body;

  if (typeof topic !== 'string' || typeof languageInput !== 'string') {
    return res.status(400).json({ error: 'Nepieciešami topic un languageInput kā teksts.' });
  }

  try {
    const prompt = `
Tu esi palīdzības rīks, kas ģenerē TESTA jautājumus LATVIEŠU valodā par tēmu "${topic}" programmēšanas valodā ${languageInput}.
Tava mērķis ir pārbaudīt lietotāja spēju izprast algoritma darbību, loģiku un kļūdu atpazīšanu kodā.

Seko šiem norādījumiem:
- Izveido 5 jautājumus ar 4 atbilžu variantiem (A, B, C, D), un atzīmē vienu pareizo.
- Jautājumiem jābūt SAISTĪTIEM ar konkrēto algoritma loģiku vai programmēšanu, nevis vispārīgu teoriju.
- Vari izmantot īsus koda fragmentus, piemēram pseudokodā vai kādā vienkāršā valodā (piemēram, Python stilā).
- Dažiem jautājumiem jāietver: "kas notiks ar šo kodu?", "kāda ir pareizā rinda?", "kurā gadījumā algoritms atgriež šo rezultātu?" utt.
- Izvairies no jautājumiem par definīcijām vai tikai terminoloģiju.
- Atbildi TIKAI ar derīgu JSON šādā struktūrā:
[
  {
    "question": "Jautājuma teksts",
    "options": {
      "A": "Atbilde A",
      "B": "Atbilde B",
      "C": "Atbilde C",
      "D": "Atbilde D"
    },
    "correct": "B"
  }
]
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [{ role: "system", content: prompt }]
    });

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

  if (passed) {
    try {
      await withDB(async (db) => {
        await db.query(
          `INSERT INTO progress (progress_id, user_id, topic, mastered, updated_at)
          VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, topic) DO UPDATE SET mastered = true, updated_at = CURRENT_TIMESTAMP`,
          [uuidv4(), userId, topic]
        );

      });
    } catch (err) {
      console.error("Kļūda saglabājot progresu:", err);
    }
  }

  res.json({ result: passed ? "Passed" : "Failed", correct: correctCount, total: answers.length });
});

app.post("/api/check-student-code", async (req, res) => {
  const { studentCode } = req.body;
  if (!studentCode || typeof studentCode !== 'string') {
    return res.status(400).json({ error: "Nederīgs studenta kods." });
  }

  try {
    let exists = false;
    await withDB(async (db) => {
      const result = await db.query(
        `SELECT 1 FROM student_codes WHERE student_code = $1 LIMIT 1`,
        [studentCode]
      );
      exists = result.rowCount > 0;

      if (!exists) {
        await db.query(
          `INSERT INTO student_codes (student_code) VALUES ($1)`,
          [studentCode]
        );
      }
    });

    res.json({ exists });
  } catch (err) {
    console.error("Kļūda pārbaudot/saglabājot studenta kodu:", err);
    res.status(500).json({ error: "Kļūda serverī." });
  }
});


app.listen(port, () => {
  console.log(`Serveris darbojas uz http://localhost:${port}`);
});