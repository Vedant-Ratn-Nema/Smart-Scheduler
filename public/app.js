let sessionId = null;
/** Last server state — sent back so cold restarts / serverless don’t reset onboarding mid-chat */
let clientSession = null;
const TZ_STORAGE_KEY = "smartSchedulerTimezone";
const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Toronto",
  "America/Vancouver",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const chatEl = document.getElementById("chat");
const chatForm = document.getElementById("chatForm");
const inputEl = document.getElementById("textInput");
const micBtn = document.getElementById("micBtn");
const ttsToggle = document.getElementById("ttsToggle");
const timezoneSelect = document.getElementById("timezoneSelect");

function getSelectedTimezone() {
  return timezoneSelect?.value || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function initTimezoneSelect() {
  if (!timezoneSelect) return;
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const saved = localStorage.getItem(TZ_STORAGE_KEY);
  const zones = [...new Set([detected, saved, ...COMMON_TIMEZONES].filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
  for (const z of zones) {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = z.replace(/_/g, " ");
    timezoneSelect.appendChild(opt);
  }
  const initial = saved && zones.includes(saved) ? saved : detected;
  timezoneSelect.value = initial;
  localStorage.setItem(TZ_STORAGE_KEY, initial);
  timezoneSelect.addEventListener("change", () => {
    localStorage.setItem(TZ_STORAGE_KEY, timezoneSelect.value);
  });
}

initTimezoneSelect();

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  chatEl.appendChild(el);
  chatEl.scrollTop = chatEl.scrollHeight;
}

let preferredTtsVoice = null;

function pickNaturalVoice() {
  const syn = window.speechSynthesis;
  if (!syn) return;
  const voices = syn.getVoices();
  if (!voices.length) return;
  const score = (v) => {
    const n = (v.name || "").toLowerCase();
    let s = 0;
    if (v.lang && v.lang.startsWith("en")) s += 3;
    if (/samantha|karen|moira|tessa|aaron|nicky|fiona|serena|google\s+us\s+english|microsoft\s+aria|premium|enhanced|natural|neural/.test(n)) {
      s += 8;
    }
    if (v.localService) s += 1;
    return s;
  };
  preferredTtsVoice = [...voices].sort((a, b) => score(b) - score(a))[0];
}

if (window.speechSynthesis) {
  pickNaturalVoice();
  window.speechSynthesis.onvoiceschanged = pickNaturalVoice;
}

/** Normalize text; URLs become “link”. */
function prepareForSpeech(raw) {
  let s = String(raw).replace(/https?:\/\/\S+/g, "link");
  s = s.replace(/\s+/g, " ").replace(/ — /g, ", ").trim();
  return s;
}

/**
 * Split into phrase chunks ending with . ! or ? so we can insert pauses between sentences.
 * (Web Speech API has no reliable SSML pause; chaining utterances works better.)
 */
function splitForSpeech(text) {
  const t = prepareForSpeech(text);
  if (!t) return [];
  const parts = [];
  const re = /[^.!?]+[.!?]+|[^.!?]+$/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const p = m[0].trim();
    if (p) parts.push(p);
  }
  return parts.length ? parts : [t];
}

const PAUSE_AFTER_SENTENCE_MS = 450;
const PAUSE_BETWEEN_MINOR_MS = 70;

function endsWithSentencePunctuation(chunk) {
  return /[.!?]["'")\]]*\s*$/.test(chunk.trim());
}

function speak(text) {
  if (!ttsToggle.checked || !window.speechSynthesis) return;
  const chunks = splitForSpeech(text);
  if (!chunks.length) return;

  const syn = window.speechSynthesis;
  syn.cancel();

  let index = 0;
  function speakNext() {
    if (index >= chunks.length) return;
    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    if (preferredTtsVoice) utterance.voice = preferredTtsVoice;
    utterance.rate = 0.92;
    utterance.pitch = 1.03;
    utterance.volume = 1;
    utterance.onend = () => {
      index += 1;
      if (index >= chunks.length) return;
      const pauseMs = endsWithSentencePunctuation(chunks[index - 1])
        ? PAUSE_AFTER_SENTENCE_MS
        : PAUSE_BETWEEN_MINOR_MS;
      setTimeout(speakNext, pauseMs);
    };
    utterance.onerror = () => {
      index += 1;
      setTimeout(speakNext, 0);
    };
    syn.speak(utterance);
  }
  speakNext();
}

async function initSession() {
  const res = await fetch("/api/session", { method: "POST" });
  const data = await res.json();
  sessionId = data.sessionId;
}

async function sendMessage(text) {
  if (!sessionId) await initSession();
  addMessage("user", text);

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      text,
      timezone: getSelectedTimezone(),
      clientSession,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    addMessage("bot", `Error: ${data.error || "Unknown server error"}`);
    return;
  }
  addMessage("bot", data.message);
  if (data.state) clientSession = data.state;
  speak(data.message);
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  await sendMessage(text);
});

document.querySelectorAll(".session-action[data-send]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const text = btn.getAttribute("data-send") || "";
    if (!text) return;
    if (text.endsWith(" ")) {
      inputEl.value = text;
      inputEl.focus();
      return;
    }
    sendMessage(text);
  });
});

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript;
    await sendMessage(transcript);
  };

  recognition.onerror = () => {
    micBtn.textContent = "🎤 Push to Talk";
  };

  recognition.onend = () => {
    micBtn.textContent = "🎤 Push to Talk";
  };

  micBtn.addEventListener("mousedown", () => {
    micBtn.textContent = "Listening...";
    recognition.start();
  });
  micBtn.addEventListener("mouseup", () => {
    recognition.stop();
  });
  micBtn.addEventListener("touchstart", () => {
    micBtn.textContent = "Listening...";
    recognition.start();
  });
  micBtn.addEventListener("touchend", () => {
    recognition.stop();
  });
} else {
  micBtn.disabled = true;
  micBtn.textContent = "Speech recognition unsupported in this browser";
}

(async function showWelcome() {
  let hostName = "the host";
  try {
    const res = await fetch("/api/public-config");
    if (res.ok) {
      const data = await res.json();
      if (data.hostName && String(data.hostName).trim()) {
        hostName = String(data.hostName).trim();
      }
    }
  } catch {
    /* keep fallback */
  }
  addMessage(
    "bot",
    `Hey — you’re booking time with ${hostName}. What’s your email? I’ll use it to send your calendar invite.`,
  );
})();
