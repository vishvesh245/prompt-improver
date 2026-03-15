// =============================================
// PromptPulse — Popup (Extension settings)
// =============================================

const keyInput = document.getElementById("key-input");
const detected = document.getElementById("detected");
const saveBtn = document.getElementById("save-btn");
const removeBtn = document.getElementById("remove-btn");
const helpLink = document.getElementById("help-link");
const statusArea = document.getElementById("status-area");
const statsArea = document.getElementById("stats-area");

// Open API key help page
helpLink.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("api-key-help.html") });
});

function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith("sk-ant-")) return "Anthropic (Claude)";
  if (key.startsWith("AIza")) return "Google (Gemini)";
  if (key.startsWith("sk-")) return "OpenAI (ChatGPT)";
  return null;
}

// Load current settings
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => {
  if (chrome.runtime.lastError || !res) return;

  if (res.hasKey) {
    statusArea.innerHTML = `
      <div class="status-card connected">
        <span class="status-icon">\u2713</span>
        <span>Connected \u2014 ${res.provider === "anthropic" ? "Anthropic" : res.provider === "openai" ? "OpenAI" : "Google"} key active</span>
      </div>
    `;
    keyInput.placeholder = "Replace with a different key...";
    removeBtn.style.display = "block";
  } else {
    const limit = res.freeLimit || 5;
    statusArea.innerHTML = `
      <div class="status-card free">
        <span class="status-icon">\u26a1</span>
        <span>${res.freeRemaining} of ${limit} free analyses remaining</span>
      </div>
    `;
  }

  const limit = res.freeLimit || 5;
  statsArea.innerHTML = `
    <div class="stat-row"><span>Free analyses used</span><span>${res.freeUsed} / ${limit}</span></div>
    <div class="stat-row"><span>API key</span><span>${res.hasKey ? "Connected" : "Not set"}</span></div>
    <div class="stat-row"><span>Works on</span><span>Claude, ChatGPT, Gemini</span></div>
  `;
});

// Key input detection
keyInput.addEventListener("input", () => {
  const val = keyInput.value.trim();
  const provider = detectProvider(val);
  if (provider) {
    detected.textContent = `\u2713 Detected: ${provider}`;
    detected.className = "detected ok";
    saveBtn.textContent = `Save ${provider} Key`;
    saveBtn.disabled = false;
  } else if (val) {
    detected.textContent = "Unrecognized key format";
    detected.className = "detected none";
    saveBtn.disabled = true;
  } else {
    detected.textContent = "";
    detected.className = "detected none";
    saveBtn.textContent = "Save Key";
    saveBtn.disabled = false;
  }
});

// Save
saveBtn.addEventListener("click", () => {
  const key = keyInput.value.trim();
  if (!key) return;

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey: key }, (res) => {
    if (chrome.runtime.lastError) {
      detected.textContent = "Extension error — try reopening";
      detected.className = "detected none";
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Key";
      return;
    }
    if (res?.success) {
      saveBtn.textContent = "Saved!";
      setTimeout(() => window.close(), 800);
    } else {
      detected.textContent = res?.error || "Failed to save";
      detected.className = "detected none";
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Key";
    }
  });
});

// Dashboard button
document.getElementById("dashboard-btn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

// Load mini stats
chrome.runtime.sendMessage({ type: "GET_STATS" }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  const stats = res.stats || [];
  const totalApplied = res.totalApplied || 0;
  if (totalApplied > 0) {
    // Calculate time saved
    const FOLLOWUP_MAP = { 1: 3.15, 2: 3.15, 3: 1.88, 4: 1.20, 5: 0.68, 6: 0.25, 7: 0.10, 8: 0, 9: 0, 10: 0 };
    const eligible = stats.filter(s => s.applied && s.originalScore <= 7 && s.improvedScore > s.originalScore);
    let totalTimeSec = 0;
    for (const s of eligible) {
      const before = FOLLOWUP_MAP[Math.max(1, Math.min(10, Math.round(s.originalScore)))] || 0;
      const after = FOLLOWUP_MAP[Math.max(1, Math.min(10, Math.round(s.improvedScore)))] || 0;
      totalTimeSec += Math.max(0, before - after) * 90;
    }
    const timeStr = totalTimeSec < 60 ? totalTimeSec + "s" : Math.round(totalTimeSec / 60) + " min";
    const miniArea = document.getElementById("mini-stats-area");
    miniArea.innerHTML = `
      <div class="mini-stats">
        <div class="mini-stat">
          <div class="mini-stat-value">${stats.length}</div>
          <div class="mini-stat-label">Analyzed</div>
        </div>
        <div class="mini-stat">
          <div class="mini-stat-value">${totalApplied}</div>
          <div class="mini-stat-label">Improved</div>
        </div>
        <div class="mini-stat">
          <div class="mini-stat-value">${timeStr}</div>
          <div class="mini-stat-label">Time saved</div>
        </div>
      </div>
    `;
  }
});

// Remove key
removeBtn.addEventListener("click", () => {
  chrome.storage.local.remove(["apiKey"], () => {
    chrome.storage.local.set({ onboardingShown: false, freeUsed: 0 }, () => {
      removeBtn.textContent = "Removed!";
      setTimeout(() => window.close(), 500);
    });
  });
});
