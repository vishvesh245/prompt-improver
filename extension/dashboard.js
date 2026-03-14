(function() {
  "use strict";

  // ── Follow-up probability model (probability-weighted) ──
  const FOLLOWUP_MAP = {
    1: 3.15, 2: 3.15,
    3: 1.88,
    4: 1.20,
    5: 0.68,
    6: 0.25,
    7: 0.10,
    8: 0, 9: 0, 10: 0,
  };

  // Cost per follow-up by platform
  const COST_PER_FOLLOWUP = {
    chatgpt: 0.0075,
    claude: 0.0107,
    gemini: 0.0037,
  };
  const DEFAULT_COST = 0.0075;
  const PP_COST_PER_ANALYSIS = 0.0005;
  const SECONDS_PER_FOLLOWUP = 90;

  function getFollowups(score) {
    return FOLLOWUP_MAP[Math.max(1, Math.min(10, Math.round(score)))] || 0;
  }

  function computeStats(stats) {
    const totalAnalyzed = stats.length;
    const applied = stats.filter(s => s.applied);
    const totalApplied = applied.length;

    // Only count eligible: applied + originalScore <= 7 + improvedScore > originalScore
    const eligible = applied.filter(s =>
      s.originalScore <= 7 && s.improvedScore > s.originalScore
    );

    let totalFollowupsSaved = 0;
    let totalTimeSavedSec = 0;
    let totalMoneySaved = 0;

    for (const s of eligible) {
      const followupsBefore = getFollowups(s.originalScore);
      const followupsAfter = getFollowups(s.improvedScore);
      const saved = Math.max(0, followupsBefore - followupsAfter);
      totalFollowupsSaved += saved;
      totalTimeSavedSec += saved * SECONDS_PER_FOLLOWUP;
      const costPerFU = COST_PER_FOLLOWUP[s.platform] || DEFAULT_COST;
      totalMoneySaved += saved * costPerFU;
    }

    const ppCost = totalAnalyzed * PP_COST_PER_ANALYSIS;
    const netSavings = totalMoneySaved - ppCost;

    // Score averages
    let avgOriginal = 0, avgImproved = 0;
    if (eligible.length > 0) {
      avgOriginal = eligible.reduce((sum, s) => sum + s.originalScore, 0) / eligible.length;
      avgImproved = eligible.reduce((sum, s) => sum + s.improvedScore, 0) / eligible.length;
    }

    // Platform breakdown
    const platformCounts = {};
    for (const s of stats) {
      platformCounts[s.platform] = (platformCounts[s.platform] || 0) + 1;
    }

    return {
      totalAnalyzed,
      totalApplied,
      eligible: eligible.length,
      totalFollowupsSaved: Math.round(totalFollowupsSaved * 10) / 10,
      totalTimeSavedSec: Math.round(totalTimeSavedSec),
      totalMoneySaved,
      ppCost,
      netSavings,
      avgOriginal: Math.round(avgOriginal * 10) / 10,
      avgImproved: Math.round(avgImproved * 10) / 10,
      platformCounts,
    };
  }

  function formatTime(seconds) {
    if (seconds < 60) return seconds + "s";
    const mins = Math.round(seconds / 60);
    if (mins < 60) return mins + " min";
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? hrs + "h " + rem + "m" : hrs + "h";
  }

  function formatMoney(amount) {
    if (amount < 0.01) return "$" + amount.toFixed(4);
    return "$" + amount.toFixed(2);
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.floor(hrs / 24);
    return days + "d ago";
  }

  function scoreColor(s) {
    if (s >= 8) return "#3fb950";
    if (s >= 5) return "#d29922";
    return "#f87171";
  }

  function render(stats) {
    const container = document.getElementById("main-content");

    if (!stats || stats.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📊</div>
          <h2>No data yet</h2>
          <p>Start using PromptPulse on ChatGPT, Claude, or Gemini. Your savings will appear here automatically.</p>
        </div>
      `;
      return;
    }

    const c = computeStats(stats);

    container.innerHTML = `
      <!-- Hero Stats -->
      <div class="hero-stats">
        <div class="hero-card">
          <div class="hero-card-label">Prompts Analyzed</div>
          <div class="hero-card-value hero-accent">${c.totalAnalyzed}</div>
          <div class="hero-card-sub">${c.totalApplied} improvements applied</div>
        </div>
        <div class="hero-card">
          <div class="hero-card-label">Time Saved</div>
          <div class="hero-card-value hero-green">${formatTime(c.totalTimeSavedSec)}</div>
          <div class="hero-card-sub">${c.totalFollowupsSaved} follow-ups avoided</div>
        </div>
        <div class="hero-card">
          <div class="hero-card-label">Money Saved</div>
          <div class="hero-card-value hero-green">${formatMoney(c.totalMoneySaved)}</div>
          <div class="hero-card-sub">in avoided API costs</div>
        </div>
        <div class="hero-card">
          <div class="hero-card-label">Net ROI</div>
          <div class="hero-card-value" style="color:${c.netSavings >= 0 ? '#3fb950' : '#f87171'}">${formatMoney(Math.abs(c.netSavings))}</div>
          <div class="hero-card-sub">${c.netSavings >= 0 ? 'net savings' : 'net cost'} (after PromptPulse cost)</div>
        </div>
      </div>

      <!-- Score Improvement -->
      ${c.eligible > 0 ? `
      <div class="section">
        <div class="section-title">📈 Score Improvement</div>
        <div class="score-improve-row">
          <div class="score-box">
            <div class="score-box-num" style="color:#f87171">${c.avgOriginal}<span class="sub">/10</span></div>
            <div class="score-box-label">Avg. original</div>
          </div>
          <div class="score-arrow">→</div>
          <div class="score-box">
            <div class="score-box-num" style="color:#3fb950">${c.avgImproved}<span class="sub">/10</span></div>
            <div class="score-box-label">Avg. improved</div>
          </div>
          <div class="score-delta">
            <div class="score-delta-num">+${(c.avgImproved - c.avgOriginal).toFixed(1)}</div>
            <div class="score-delta-label">avg. improvement</div>
          </div>
        </div>
      </div>
      ` : ''}

      <!-- ROI Breakdown -->
      <div class="section">
        <div class="section-title">💰 ROI Breakdown</div>
        <div class="roi-grid">
          <div class="roi-item">
            <div class="roi-item-value green">${formatMoney(c.totalMoneySaved)}</div>
            <div class="roi-item-label">Saved in API costs</div>
          </div>
          <div class="roi-item">
            <div class="roi-item-value red">${formatMoney(c.ppCost)}</div>
            <div class="roi-item-label">PromptPulse cost (${c.totalAnalyzed} analyses)</div>
          </div>
          <div class="roi-item">
            <div class="roi-item-value" style="color:${c.netSavings >= 0 ? '#3fb950' : '#f87171'}">${c.netSavings >= 0 ? '+' : '-'}${formatMoney(Math.abs(c.netSavings))}</div>
            <div class="roi-item-label">Net savings</div>
          </div>
        </div>
      </div>

      <!-- Comparison: PromptPulse vs Ask AI -->
      <div class="section">
        <div class="section-title">⚖️ PromptPulse vs. "Ask the AI to improve my prompt"</div>
        <table class="compare-table">
          <thead>
            <tr><th>Factor</th><th>PromptPulse</th><th>Manual (ask AI)</th></tr>
          </thead>
          <tbody>
            <tr><td>Cost per improvement</td><td class="green">~$0.0005</td><td>~$0.0075 – $0.0107</td></tr>
            <tr><td>Time per improvement</td><td class="green">0 sec (automatic)</td><td>~45 sec (copy, paste, wait)</td></tr>
            <tr><td>Conversation pollution</td><td class="green">None</td><td class="red">Adds 2 messages to context</td></tr>
            <tr><td>Works automatically</td><td class="green">Yes — as you type</td><td class="red">Manual every time</td></tr>
            <tr><td>Score + specific issues</td><td class="green">Yes</td><td class="muted">Not unless you ask</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Recent Activity -->
      <div class="section">
        <div class="section-title">🕐 Recent Activity</div>
        <div class="activity-list" id="activity-list"></div>
      </div>

      <!-- Footer CTA -->
      <div class="footer-cta">
        <a href="dashboard-methodology.html">How we calculate your savings →</a>
        <span class="sep">|</span>
        <a href="https://github.com/vishvesh245/prompt-improver" target="_blank">GitHub</a>
        <span class="sep">|</span>
        <a href="https://vishvesh245.github.io/prompt-improver/privacy-policy.html" target="_blank">Privacy Policy</a>
      </div>
    `;

    // Render activity feed (last 50, most recent first)
    const activityList = document.getElementById("activity-list");
    if (activityList) {
      const recent = stats.slice(-50).reverse();
      if (recent.length === 0) {
        activityList.innerHTML = '<div style="color:#484f58;font-size:13px;padding:12px 0;">No activity yet.</div>';
      } else {
        activityList.innerHTML = recent.map(s => {
          const dotClass = s.applied ? "applied" : "skipped";
          const action = s.applied ? "Applied" : "Analyzed";
          const scoreHtml = s.improvedScore && s.applied
            ? `<span class="activity-score" style="color:${scoreColor(s.originalScore)}">${s.originalScore}</span> → <span class="activity-score" style="color:${scoreColor(s.improvedScore)}">${s.improvedScore}</span>`
            : `<span class="activity-score" style="color:${scoreColor(s.originalScore)}">Score: ${s.originalScore}</span>`;
          return `
            <div class="activity-item">
              <div class="activity-dot ${dotClass}"></div>
              <span class="activity-platform">${(s.platform || 'unknown').charAt(0).toUpperCase() + (s.platform || 'unknown').slice(1)}</span>
              <span>${action}</span>
              ${scoreHtml}
              <span class="activity-time">${timeAgo(s.timestamp)}</span>
            </div>
          `;
        }).join("");
      }
    }
  }

  // ── Load stats from chrome.storage ──
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ type: "GET_STATS" }, (res) => {
      if (chrome.runtime.lastError) {
        render([]);
        return;
      }
      render(res?.stats || []);
    });
  } else {
    // Fallback for testing outside extension context
    render([]);
  }
})();
