let sessionId = null;
let messages = [];
let languageLocked = false;
let currentTest = [];

// ========================== PALĪGFUNKCIJAS ============================

// Apgūto tēmu saraksta aizpildīšana
function populateMasteredTopics(topics) {
  const masteredList = document.getElementById("masteredList");
  masteredList.textContent = "";
  if (topics && topics.length > 0) {
    for (const topic of topics) {
      const li = document.createElement("li");
      li.textContent = topic;
      masteredList.appendChild(li);
    }
  } else {
    const li = document.createElement("li");
    li.textContent = "(Nav apgūtu tēmu)";
    masteredList.appendChild(li);
  }
  updateCrownDisplay(topics, window.allTopics);
}

// Ielādes pārklājuma parādīšana/slēpšana
function toggleLoading(isVisible) {
  const overlay = document.getElementById("loadingOverlay");
  overlay.classList.toggle("show", isVisible);
}

// Bezsaistes brīdinājuma parādīšana/slēpšana
function toggleOfflineBanner(isVisible) {
  const banner = document.getElementById("offlineBanner");
  banner.classList.toggle("hidden", !isVisible);
}

// UI pārslēgšana testa režīmā
function enterTestMode() {
  document.getElementById("chatSection").classList.add("hidden");
  document.getElementById("testSection").classList.remove("hidden");
  document.querySelectorAll("button").forEach(btn => btn.disabled = true);
}

function exitTestMode() {
  document.getElementById("testSection").classList.add("hidden");
  document.getElementById("chatSection").classList.remove("hidden");
  document.querySelectorAll("button").forEach(btn => btn.disabled = false);
}

// Ievadlauku iegūšana
function getSelectedLanguageAndTopic() {
  const language = document.getElementById("language").value.trim();
  const topic = document.getElementById("topic").value.trim();
  return { language, topic };
}

// Validācija
function validateRequiredFields(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (!value) {
      alert(`Lauks "${name}" ir obligāti jāaizpilda!`);
      return false;
    }
  }
  return true;
}

function startConfetti() {
  confetti({
    particleCount: 150,
    spread: 70,
    origin: { y: 0.6 }
  });
}

function updateCrownDisplay(masteredTopics, allTopics) {
  const allMastered = allTopics.every(t => masteredTopics.includes(t));
  const crownIcon = document.getElementById("crownIcon");
  if (allMastered) {
    crownIcon.style.display = "block";
    if (!localStorage.getItem('crownCelebrated')) {
      startConfetti();
      alert("Apsveicam! Tu esi apguvis VISAS tēmas! 🎉");
      localStorage.setItem('crownCelebrated', 'true');
    }
  } else {
    crownIcon.style.display = "none";
    localStorage.removeItem('crownCelebrated');
  }
}

function appendOutput(who, message) {
  const output = document.getElementById("output");
  const messageDiv = document.createElement("div");
  messageDiv.classList.add(who === "Tu" ? "user-message" : "assistant-message");
  const formattedMessage = message.replace(/\n/g, "<br>");
  messageDiv.innerHTML = `<strong>${who}:</strong> ${formattedMessage}`;
  output.appendChild(messageDiv);
  output.scrollTop = output.scrollHeight;
}

async function postJSON(url, data) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });

    const contentType = res.headers.get("Content-Type") || "";

    if (!res.ok) {
      const errMessage = contentType.includes("application/json")
        ? (await res.json()).message
        : await res.text();
      throw new Error(errMessage || "Nezināma kļūda");
    }

     toggleOfflineBanner(false);

    if (contentType.includes("application/json")) {
      return await res.json();
    } else {
      return { message: await res.text(), mode: "offline" };
    }
  } catch (err) {
    console.error("Tīkla kļūda:", err);
    toggleOfflineBanner(true);
    alert("Kļūda: " + err.message); // izvēles iespēja – parādi kļūdu lietotājam
    return { mode: "offline" };
  }
}


function getUserId() {
  let userId = localStorage.getItem("userId");
  if (!userId) {
    userId = crypto.randomUUID();
    localStorage.setItem("userId", userId);
  }
  return userId;
}

// ========================== GALVENĀ IELĀDE ============================

window.addEventListener("load", async () => {
  // Automātiski ielādē studentCode no localStorage, ja tāds ir
  const savedStudentCode = localStorage.getItem("studentCode");
  if (savedStudentCode) {
    const input = document.getElementById("studentCode");
    input.value = savedStudentCode;
    input.disabled = true;
  }

  const response = await fetch("/topics.json");
  const topicsData = await response.json();
  window.allTopics = topicsData.topics.map(t => t.id);
  window.topicRelations = topicsData.relations;

  const topicSelect = document.getElementById("topic");
  topicsData.topics.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.lv;
    topicSelect.appendChild(opt);
  });

  const userId = getUserId();
  toggleLoading(true);

  try {
    const data = await postJSON("/api/load-session", { userId });

    if (data.messages && data.messages.length > 0) {
      messages = data.messages;
      document.getElementById("output").textContent = "";
      for (const msg of messages) {
        const who = msg.role === "user" ? "Tu" : "GPT";
        appendOutput(who, String(msg.content));
      }

      document.getElementById("language").value = data.language || "";
      topicSelect.value = data.topic || "";
      sessionId = data.sessionId;
      console.log("sessionId:", sessionId);

      document.getElementById("resetBtn").classList.remove("hidden");
      document.getElementById("language").disabled = true;
      topicSelect.disabled = true;
      languageLocked = true;

      populateMasteredTopics(data.masteredTopics);

      document.getElementById("startTestBtn").classList.remove("hidden");
    } else {
      populateMasteredTopics([]);
    }

  } catch (err) {
    console.error("Neizdevās ielādēt sesiju:", err);
    toggleOfflineBanner(true);
  } finally {
    toggleLoading(false);
  }
});

// ========================== EVENT HANDLERI ============================

document.getElementById("sendBtn").addEventListener("click", async () => {
    const studentCode = document.getElementById("studentCode").value.trim();
  if (!studentCode) {
    alert("Lūdzu, ievadi studenta apliecības numuru!");
    sendButton.disabled = false;
    return;
  }

  if (!localStorage.getItem("studentCode")) {
    const result = await postJSON("/api/check-student-code", { studentCode });

    if (result.error) {
      alert("Kļūda pārbaudot apliecības numuru.");
      sendButton.disabled = false;
      return;
    }

    if (result.exists) {
      alert("Šāds apliecības numurs jau ir reģistrēts. Varat turpināt.");
    } else {
      alert("Studenta apliecības numurs reģistrēts.");
    }

    localStorage.setItem("studentCode", studentCode);
    document.getElementById("studentCode").disabled = true;
  }

  const sendButton = document.getElementById("sendBtn");
  const startTestButton = document.getElementById("startTestBtn");
  sendButton.disabled = true;
  startTestButton.disabled = true;

  const userInput = document.getElementById("input").value.trim();
  const { language, topic } = getSelectedLanguageAndTopic();

  if (!validateRequiredFields({ "Programmēšanas valoda": language, "Tēma": topic, "Ziņojums": userInput })) {
    sendButton.disabled = false;
    return;
  }

  if (!languageLocked) {
    document.getElementById("language").disabled = true;
    document.getElementById("topic").disabled = true;
    document.getElementById("resetBtn").classList.remove("hidden");
    languageLocked = true;
    const startData = await postJSON("/api/start-session", {
      userId: getUserId(),
      languageInput: language,
      topic
    });
    sessionId = startData.sessionId;
  }

  if (sessionId) {
    document.getElementById("startTestBtn").classList.remove("hidden");
  }

  messages.push({ role: "user", content: userInput });
  appendOutput("Tu", userInput);

  const loadingDiv = document.createElement("div");
  loadingDiv.innerHTML = `<em>Atbilde tiek ģenerēta...</em>`;
  document.getElementById("output").appendChild(loadingDiv);

  try {
    const data = await postJSON("/api/chat", {
      messages: [{ role: "user", content: userInput }],
      languageInput: language,
      userId: getUserId(),
      sessionId,
      topic
    });

    loadingDiv.remove();
    const reply = data.reply || "[Nav atbildes]";
    messages.push({ role: "assistant", content: reply });
    appendOutput("GPT", reply);

    const btn = document.getElementById("startTestBtn");
    btn.classList.remove("hidden");

  } catch (err) {
    loadingDiv.remove();
    alert("Kļūda!");
    console.error(err);
  } finally {
    document.getElementById("input").value = "";
    sendButton.disabled = false;
    startTestButton.disabled = false;
  }
});

document.getElementById("startTestBtn").addEventListener("click", async () => {
  const { language, topic } = getSelectedLanguageAndTopic();
  if (!validateRequiredFields({ "Programmēšanas valoda": language, "Tēma": topic })) return;

  enterTestMode();
  const testDiv = document.getElementById("testQuestions");
  testDiv.innerHTML = "<p style='font-style: italic;'>Tests tiek ģenerēts, lūdzu uzgaidi...</p>";
  await new Promise(requestAnimationFrame);

  const res = await postJSON("/api/get-test", { topic, languageInput: language });
  if (res.test) {
    currentTest = res.test;
    testDiv.innerHTML = "";
    currentTest.forEach((q, idx) => {
      const qDiv = document.createElement("div");
      qDiv.classList.add("question");
      qDiv.innerHTML = `<strong>${idx + 1}. ${q.question}</strong>` +
        Object.entries(q.options).map(([key, text]) =>
          `<label><div class="option-container"><input type="radio" name="q${idx}" value="${key}"><span class="option-label">${key}:</span> <div>${text}</div></div></label>`
        ).join("");
      testDiv.appendChild(qDiv);
    });
    document.getElementById("submitTestBtn").disabled = false;
  } else {
    alert("Neizdevās ielādēt testu.");
    exitTestMode();
  }
});

document.getElementById("submitTestBtn").addEventListener("click", async () => {
  const answers = currentTest.map((q, idx) => {
    const selected = document.querySelector(`input[name="q${idx}"]:checked`);
    return {
      question: q.question,
      selected: selected ? selected.value : null,
      isCorrect: selected ? selected.value === q.correct : false
    };
  });

  const res = await postJSON("/api/submit-test", {
    userId: getUserId(),
    topic: document.getElementById("topic").value.trim(),
    answers
  });

  alert(`Rezultāts: ${res.result}\nPareizas atbildes: ${res.correct}/${res.total}`);
  await reloadMasteredTopics();
  exitTestMode();
});

async function reloadMasteredTopics() {
  const data = await postJSON("/api/load-session", { userId: getUserId() });
  console.log("reloadMasteredTopics saņēma:", data.masteredTopics);
  populateMasteredTopics(data.masteredTopics);
}

document.getElementById("resetBtn").addEventListener("click", () => {
  messages = [];
  languageLocked = false;
  sessionId = null;
  document.getElementById("output").textContent = "";
  document.getElementById("input").value = "";
  document.getElementById("language").value = "";
  document.getElementById("topic").value = "";
  document.getElementById("language").disabled = false;
  document.getElementById("topic").disabled = false;
  document.getElementById("resetBtn").classList.add("hidden");
  document.getElementById("startTestBtn").classList.add("hidden");
});

document.getElementById("displayUserId").textContent = getUserId();

document.getElementById("btnSetUserId").addEventListener("click", () => {
  const inputUserId = document.getElementById("inputUserId").value.trim();
  if (inputUserId) {
    localStorage.setItem('userId', inputUserId);
    alert("Lietotāja ID iestatīts! Lapa tiks pārlādēta, lai ielādētu Tavu sesiju.");
    location.reload();
  } else {
    alert("Lūdzu, ievadi derīgu lietotāja ID.");
  }
});

document.getElementById("toggleUserIdSection").addEventListener("click", () => {
  const section = document.getElementById("userIdSection");
  section.style.display = (getComputedStyle(section).display === 'none') ? 'block' : 'none';
});