require('dotenv').config();
const readlineSync = require('readline-sync');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function runChat() {
  // Studentu līmeņa izvēle ar validāciju
  console.log("Izvēlies savu līmeni:");
  console.log("1. Iesācējs (nekad neesmu programmējis)");
  console.log("2. Vidējs (esmu rakstījis vienkāršus skriptus)");
  console.log("3. Pieredzējis (esmu strādājis ar vairākiem projektiem)");

  let levelNum;
  while (true) {
    levelNum = readlineSync.question("Ievadi skaitli (1-3): ");
    if (["1", "2", "3"].includes(levelNum)) break;
    console.log("Lūdzu ievadi 1, 2 vai 3.");
  }

  const levelMap = {
    "1": "beginner",
    "2": "intermediate",
    "3": "advanced",
  };
  const level = levelMap[levelNum];

  // Programmēšanas valodas ievade
  const languageInput = readlineSync.question("Ar kadu programmesanas valodu tu velies palidzibu? ");

  
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

Your tone should be supportive, curious, and focused on helping the student grow their understanding.
`;

  console.log("\nGPT ir gatavs sarunai! Raksti 'iziet', lai pārtrauktu.\n");

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "assistant",
      content:
        `Hi! I'm your virtual tutor. You're learning ${languageInput} at the ${level} level. Let's explore AI search algorithms together — I’ll help you understand the core ideas and think through the problems step by step!`,
    },
  ];

  console.log("GPT: " + messages[1].content);


  while (true) {
    const userInput = readlineSync.question("Tu: ");
    if (userInput.toLowerCase() === 'iziet') break;

    messages.push({ role: "user", content: userInput });

    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: messages,
    });

    const response = chatCompletion.choices[0].message.content;
    console.log("GPT: " + response);

    messages.push({ role: "assistant", content: response });
  }
}

runChat();
