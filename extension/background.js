// =============================================
// PromptPulse — Background Service Worker
// =============================================

const API_BASE = "https://prompt-improver-production.up.railway.app";
const DEFAULT_FREE_LIMIT = 5; // fallback if server is unreachable

let FREE_LIMIT = DEFAULT_FREE_LIMIT;

// Fetch remote config on startup (change limits without extension update)
// Also persists to storage so it survives service worker restarts
async function fetchRemoteConfig() {
  // First, load cached config from storage (fast — available instantly)
  try {
    const cached = await chrome.storage.local.get(["cachedFreeLimit"]);
    if (cached.cachedFreeLimit !== undefined) {
      FREE_LIMIT = cached.cachedFreeLimit;
      console.log("[PromptPulse] Loaded cached freeLimit:", FREE_LIMIT);
    }
  } catch {}

  // Then fetch fresh config from server (may take a moment)
  try {
    const res = await fetch(`${API_BASE}/config`, { signal: AbortSignal.timeout(5000) });
    const config = await res.json();
    if (config.freeLimit !== undefined) {
      FREE_LIMIT = config.freeLimit;
      // Cache it so next service worker restart has it immediately
      await chrome.storage.local.set({ cachedFreeLimit: FREE_LIMIT });
    }
    console.log("[PromptPulse] Remote config loaded — freeLimit:", FREE_LIMIT);
  } catch {
    console.log("[PromptPulse] Remote config unavailable, using freeLimit:", FREE_LIMIT);
  }
}
fetchRemoteConfig();

// Detect provider from API key prefix
function detectProvider(apiKey) {
  if (!apiKey) return null;
  if (apiKey.startsWith("sk-ant-")) return "anthropic";
  if (apiKey.startsWith("AIza")) return "google";
  if (apiKey.startsWith("sk-")) return "openai";
  return null;
}

// Get stored settings
async function getSettings() {
  const data = await chrome.storage.local.get(["apiKey", "freeUsed"]);
  return {
    apiKey: data.apiKey || "",
    freeUsed: data.freeUsed || 0,
  };
}

// Increment free usage count
async function incrementFreeUsage() {
  const { freeUsed } = await getSettings();
  await chrome.storage.local.set({ freeUsed: freeUsed + 1 });
  return freeUsed + 1;
}

// Save API key
async function saveApiKey(apiKey) {
  await chrome.storage.local.set({ apiKey });
}

// Call the improve API
async function callImproveAPI(prompt, apiKey, provider) {
  const res = await fetch(`${API_BASE}/improve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, api_key: apiKey, provider }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Server error (${res.status}) — please try again`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "API request failed");
  return json.data;
}

// Call the free tier endpoint (uses server's own key)
async function callFreeAPI(prompt) {
  const res = await fetch(`${API_BASE}/improve-free`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Server error (${res.status}) — please try again`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "Free API request failed");
  return json.data;
}

// Message handler — content script communicates via messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_SETTINGS") {
    getSettings().then(settings => {
      const provider = detectProvider(settings.apiKey);
      sendResponse({
        hasKey: !!settings.apiKey,
        provider,
        freeUsed: settings.freeUsed,
        freeLimit: FREE_LIMIT,
        freeRemaining: Math.max(0, FREE_LIMIT - settings.freeUsed),
      });
    });
    return true; // async response
  }

  if (msg.type === "SAVE_API_KEY") {
    const provider = detectProvider(msg.apiKey);
    if (!provider) {
      sendResponse({ success: false, error: "Unrecognized API key format. Supported: Anthropic (sk-ant-), OpenAI (sk-), Google (AIza)." });
    } else {
      saveApiKey(msg.apiKey).then(() => {
        sendResponse({ success: true, provider });
      });
    }
    return true;
  }

  // ── Stats tracking for Savings Dashboard ──
  if (msg.type === "TRACK_STAT") {
    // msg.stat = { timestamp, platform, originalScore, improvedScore, applied }
    (async () => {
      const data = await chrome.storage.local.get(["ppStats", "ppTotalApplied"]);
      const stats = data.ppStats || [];
      const totalApplied = data.ppTotalApplied || 0;
      stats.push(msg.stat);
      const newTotal = msg.stat.applied ? totalApplied + 1 : totalApplied;
      await chrome.storage.local.set({ ppStats: stats, ppTotalApplied: newTotal });
      sendResponse({ success: true, totalApplied: newTotal, totalAnalyzed: stats.length });
    })();
    return true;
  }

  if (msg.type === "MARK_APPLIED") {
    (async () => {
      const data = await chrome.storage.local.get(["ppStats", "ppTotalApplied"]);
      const stats = data.ppStats || [];
      const totalApplied = data.ppTotalApplied || 0;
      // Find the last non-applied stat and mark it applied
      for (let i = stats.length - 1; i >= 0; i--) {
        if (!stats[i].applied) {
          stats[i].applied = true;
          if (msg.improvedScore) stats[i].improvedScore = msg.improvedScore;
          break;
        }
      }
      const newTotal = totalApplied + 1;
      await chrome.storage.local.set({ ppStats: stats, ppTotalApplied: newTotal });
      sendResponse({ success: true, totalApplied: newTotal });
    })();
    return true;
  }

  if (msg.type === "GET_STATS") {
    chrome.storage.local.get(["ppStats", "ppTotalApplied", "ppLastMilestoneShown"], (data) => {
      sendResponse({
        stats: data.ppStats || [],
        totalApplied: data.ppTotalApplied || 0,
        lastMilestoneShown: data.ppLastMilestoneShown || 0,
      });
    });
    return true;
  }

  if (msg.type === "SET_MILESTONE") {
    chrome.storage.local.set({ ppLastMilestoneShown: msg.milestone }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === "IMPROVE_PROMPT") {
    (async () => {
      try {
        const settings = await getSettings();

        // User has their own key
        if (settings.apiKey) {
          const provider = detectProvider(settings.apiKey);
          const result = await callImproveAPI(msg.prompt, settings.apiKey, provider);
          sendResponse({ success: true, data: result });
          return;
        }

        // Free tier
        if (settings.freeUsed >= FREE_LIMIT) {
          sendResponse({
            success: false,
            error: "FREE_LIMIT_REACHED",
            message: `You've used all ${FREE_LIMIT} free analyses. Add your API key for unlimited use.`,
          });
          return;
        }

        const result = await callFreeAPI(msg.prompt);
        await incrementFreeUsage();
        const newSettings = await getSettings();
        sendResponse({
          success: true,
          data: result,
          freeRemaining: Math.max(0, FREE_LIMIT - newSettings.freeUsed),
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
