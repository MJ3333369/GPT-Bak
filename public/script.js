let sessionId = null;
let messages = [];
let languageLocked = false;
let currentTest = [];

const allTopics = [
  "Breadth-First Search",
  "Depth-First Search",
  "Minimax",
  "Alpha-Beta"
];

function getUserId() {
  let userId = localStorage.getItem("userId");
  if (!userId) {
    userId = crypto.randomUUID();
    localStorage.setItem("userId", userId);
  }
  return userId;
}

function showOfflineBanner() {
  document.getElementById("offlineBanner").classList.remove("hidden");
}

function hideOfflineBanner() {
  document.getElementById("offlineBanner").classList.add("hidden");
}

async function postJSON(url, data) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    console.error("Tīkla kļūda:", err);
    showOfflineBanner();
    return { mode: "offline" };
  }
}


function showLoadingSession() {
  document.getElementById("loadingOverlay").classList.add("show");
}

function hideLoadingSession() {
  document.getElementById("loadingOverlay").classList.remove("show");
}

function startConfetti() {
  confetti({
    particleCount: 150,
    spread: 70,
    origin: { y: 0.6 }
  });
}

function updateCrownDisplay(masteredTopics) {
  const allMastered = allTopics.every(t => masteredTopics.includes(t));
  const crownIcon = document.getElementById("crownIcon");

  if (allMastered) {
    crownIcon.style.display = "block";

    // Tikai pirmajā reizē rādam alert un konfeti
    if (!localStorage.getItem('crownCelebrated')) {
      startConfetti();
      alert("Apsveicam! Tu esi apguvis VISAS tēmas! 🎉");
      localStorage.setItem('crownCelebrated', 'true');
    }

  } else {
    crownIcon.style.display = "none";
    localStorage.removeItem('crownCelebrated'); // Ja zaudē statusu, atkal atļaujam nākotnē
  }
}


// Ielādējam sesiju
window.addEventListener("load", async () => {
  const userId = getUserId();

  showLoadingSession();  // sākumā parādām overlay

  try {
    const data = await postJSON("/api/load-session", { userId });

    if (data.messages && data.messages.length > 0) {
      messages = data.messages;
      const output = document.getElementById("output");
      output.textContent = "";

      for (const msg of messages) {
        const who = msg.role === "user" ? "Tu" : "GPT";
        appendOutput(who, String(msg.content));
      }

      const languageInput = document.getElementById("language");
      const topicSelect = document.getElementById("topic");

      languageInput.value = data.language || "";
      topicSelect.value = data.topic || "";

      sessionId = data.sessionId;

      document.getElementById("resetBtn").classList.remove("hidden");
      languageInput.disabled = true;
      topicSelect.disabled = true;
      languageLocked = true;

      const masteredList = document.getElementById("masteredList");
      masteredList.textContent = "";

      if (data.masteredTopics && data.masteredTopics.length > 0) {
        data.masteredTopics.forEach(topic => {
          const li = document.createElement("li");
          li.textContent = topic;
          masteredList.appendChild(li);
        });
      } else {
        const li = document.createElement("li");
        li.textContent = "(Nav apgūtu tēmu)";
        masteredList.appendChild(li);
      }

      updateCrownDisplay(data.masteredTopics);

    } else {
      updateCrownDisplay([]);  // ja nav ziņu, paslēp kronīti
    }

  } catch (err) {
    console.error("Neizdevās ielādēt pēdējo sesiju:", err);
    showOfflineBanner();
  } finally {
    hideLoadingSession();  // ✅ ŠEIT IR OBLIGĀTI jābūt!
  }
});



function appendOutput(who, message) {
  const output = document.getElementById("output");
  const messageDiv = document.createElement("div");
  messageDiv.classList.add(who === "Tu" ? "user-message" : "assistant-message");
  messageDiv.textContent = `${who}: ${message}`;
  output.appendChild(messageDiv);
  output.scrollTop = output.scrollHeight;
}

async function sendMessage() {
  const sendButton = document.getElementById("sendBtn");
  const startTestButton = document.getElementById("startTestBtn");
  sendButton.disabled = true;
  startTestButton.disabled = true;

  const userInput = document.getElementById("input").value.trim();
  const languageInput = document.getElementById("language").value.trim();
  const topic = document.getElementById("topic").value.trim();

  if (!userInput || !languageInput || !topic) {
    alert("Aizpildi visus laukus!");
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
      languageInput,
      topic
    });
    sessionId = startData.sessionId;
  }

  messages.push({ role: "user", content: userInput });
  appendOutput("Tu", userInput);

  const output = document.getElementById("output");
  const loadingDiv = document.createElement("div");
  loadingDiv.innerHTML = `<em>Atbilde tiek ģenerēta...</em>`;
  output.appendChild(loadingDiv);

  try {
    const data = await postJSON("/api/chat", {
      messages,
      languageInput,
      userId: getUserId(),
      sessionId,
      topic
    });

    loadingDiv.remove();

    const reply = data.reply || "[Nav atbildes]";
    messages.push({ role: "assistant", content: reply });
    appendOutput("GPT", reply);
  } catch (err) {
    loadingDiv.remove();
    alert("Kļūda!");
    console.error(err);
  } finally {
    document.getElementById("input").value = "";
    sendButton.disabled = false;
    startTestButton.disabled = false;
  }
}

async function startTest() {
  const topic = document.getElementById("topic").value.trim();
  const languageInput = document.getElementById("language").value.trim();

  if (!topic || !languageInput) {
    alert("Izvēlies tēmu un ievadi prog. valodu");
    return;
  }

  document.getElementById("language").disabled = true;
  document.getElementById("topic").disabled = true;

  document.getElementById("chatSection").classList.add("hidden");
  document.getElementById("testSection").classList.remove("hidden");

  const testDiv = document.getElementById("testQuestions");
  testDiv.innerHTML = "<p style='font-style: italic;'>Tests tiek ģenerēts, lūdzu uzgaidi...</p>";

  document.querySelectorAll("button").forEach(btn => btn.disabled = true);

  await new Promise(requestAnimationFrame);

  const res = await postJSON("/api/get-test", { topic, languageInput });

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

    document.querySelectorAll("button").forEach(btn => btn.disabled = true);
    document.getElementById("submitTestBtn").disabled = false;
  } else {
    alert("Neizdevās ielādēt testu.");
    document.querySelectorAll("button").forEach(btn => btn.disabled = false);
  }
}

async function submitTest() {
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

  document.getElementById("testSection").classList.add("hidden");
  document.getElementById("chatSection").classList.remove("hidden");
  document.querySelectorAll("button").forEach(btn => btn.disabled = false);
}

async function reloadMasteredTopics() {
  const data = await postJSON("/api/load-session", { userId: getUserId() });
  console.log("✅ reloadMasteredTopics saņēma:", data.masteredTopics);

  const masteredList = document.getElementById("masteredList");
  masteredList.textContent = "";

  if (data.masteredTopics && data.masteredTopics.length > 0) {
    data.masteredTopics.forEach(topic => {
      const li = document.createElement("li");
      li.textContent = topic;
      masteredList.appendChild(li);
    });
  } else {
    const li = document.createElement("li");
    li.textContent = "(Nav apgūtu tēmu)";
    masteredList.appendChild(li);
  }

  updateCrownDisplay(data.masteredTopics);
}

function resetChat() {
  messages = [];
  languageLocked = false;

  document.getElementById("output").textContent = "";
  document.getElementById("input").value = "";
  document.getElementById("language").value = "";
  document.getElementById("topic").value = "";
  document.getElementById("language").disabled = false;
  document.getElementById("topic").disabled = false;
  document.getElementById("resetBtn").classList.add("hidden");
}

document.getElementById("sendBtn").addEventListener("click", sendMessage);
document.getElementById("resetBtn").addEventListener("click", resetChat);
document.getElementById("startTestBtn").addEventListener("click", startTest);
document.getElementById("submitTestBtn").addEventListener("click", submitTest);

document.getElementById('displayUserId').textContent = getUserId();

document.getElementById('btnSetUserId').addEventListener('click', () => {
  const inputUserId = document.getElementById('inputUserId').value.trim();
  if (inputUserId) {
    localStorage.setItem('userId', inputUserId);
    alert("Lietotāja ID iestatīts! Lapa tiks pārlādēta, lai ielādētu Tavu sesiju.");
    location.reload();
  } else {
    alert("Lūdzu, ievadi derīgu lietotāja ID.");
  }
});

document.getElementById('toggleUserIdSection').addEventListener('click', () => {
  const section = document.getElementById('userIdSection');
  if (section.style.display === 'none' || section.style.display === '') {
    section.style.display = 'block';
  } else {
    section.style.display = 'none';
  }
});
