// =============================================
// PromptPulse — Content Script
// Injects badge + popup on AI chat sites
// =============================================

(function () {
  "use strict";

  if (window.__piInjected) return;
  window.__piInjected = true;

  // ─── CONFIG ────────────────────────────
  const DEBOUNCE_MS = 300;
  const MIN_PROMPT_LENGTH = 10;

  // Score thresholds — single source of truth
  const HIGH_SCORE = 8;            // Green / "Looking good!" / "Great prompt!"
  const BADGE_MID_SCORE = 4;       // Badge: yellow threshold (softer than popup)
  const POPUP_MID_SCORE = 5;       // Popup: yellow threshold

  // ─── STATE ─────────────────────────────
  let badge = null;
  let popup = null;
  let onboarding = null;
  let currentScore = null;
  let currentResult = null;
  let isPopupOpen = false;
  let isOnboardingOpen = false;
  let debounceTimer = null;
  let positionInterval = null;
  let lastAnalyzedText = "";
  let cachedPromptText = "";   // Text of last successfully analyzed prompt
  let cachedResult = null;     // Cached API result for that prompt
  let activeInputEl = null;
  let mainComposerEl = null; // The initial main composer element (bottom of page)
  let stickyEditBox = null; // When set, we "lock" onto this edit box and ignore focusin on other elements
  let userDragPos = null;   // {left, top} when user has dragged the popup; null = auto-position
  let isDragging = false;
  let dragStart = null;      // {mouseX, mouseY, popupLeft, popupTop} during drag
  let dragRafId = null;
  let hasShownCelebration = false; // Show toast only once per page load

  // ─── SAVINGS DASHBOARD CONFIG ──────────
  const MILESTONES = [10, 25, 50, 100]; // Then every 100 after
  const MILESTONE_MIN_TIME = { 10: 600, 25: 1800, 50: 3600, 100: 0 }; // seconds since install
  const FOLLOWUP_MAP = { 1: 3.15, 2: 3.15, 3: 1.88, 4: 1.20, 5: 0.68, 6: 0.25, 7: 0.10, 8: 0, 9: 0, 10: 0 };

  // ─── DETECT PLATFORM & THEME ──────────
  function detectPlatform() {
    const host = window.location.hostname;
    if (host.includes("claude.ai")) return "claude";
    if (host.includes("openai.com") || host.includes("chatgpt.com")) return "chatgpt";
    if (host.includes("gemini.google.com")) return "gemini";
    return "unknown";
  }

  function detectTheme() {
    const bg = window.getComputedStyle(document.body).backgroundColor;
    if (bg) {
      const match = bg.match(/\d+/g);
      if (match) {
        const [r, g, b] = match.map(Number);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b);
        return luminance < 128 ? "dark" : "light";
      }
    }
    if (document.documentElement.classList.contains("dark") ||
        document.documentElement.dataset.theme === "dark") {
      return "dark";
    }
    return "light";
  }

  // ─── LOCAL HEURISTIC SCORING ──────────
  function quickScore(text) {
    if (!text || text.length < 5) return 0;
    const t = text.trim();
    const words = t.split(/\s+/).length;

    // Start low, earn points
    let score = 3;

    // ── Length & detail signals ──
    if (words >= 10) score += 1;
    if (words >= 25) score += 1;
    if (words >= 50) score += 1;

    // ── Structure signals ──
    if (/you are a|act as|as a|role of|your role|pretend you/i.test(t)) score += 1;       // role
    if (/json|list|table|bullet|markdown|csv|format|structure|numbered|step.by.step/i.test(t)) score += 1; // format
    if (/\d+\s*words|\d+\s*sentences|concise|brief|short|maximum|at most|no more than|under \d+|limit/i.test(t)) score += 1; // constraints
    if (/tone|audience|beginner|expert|professional|casual|formal|friendly|technical/i.test(t)) score += 1; // audience/tone

    // ── Penalty: ultra-vague or greeting-like ──
    if (words <= 5) score = Math.min(score, 3);
    if (/^(help|hi|hello|hey|thanks|ok|yes|no|please)\b/i.test(t)) score = Math.min(score, 2);

    return Math.max(1, Math.min(10, score));
  }

  function scoreClass(s) { return s >= HIGH_SCORE ? "pi-score-high" : s >= POPUP_MID_SCORE ? "pi-score-mid" : "pi-score-low"; }
  function scoreBannerClass(s) { return s >= HIGH_SCORE ? "pi-banner-high" : s >= POPUP_MID_SCORE ? "pi-banner-mid" : "pi-banner-low"; }
  function badgeLabel(s) {
    return s >= HIGH_SCORE ? "Looking good!" :
           s >= BADGE_MID_SCORE ? "Good start \u2014 tap to improve" :
                    "Needs work \u2014 tap to improve";
  }
  function scoreLabelBanner(s) {
    return s >= HIGH_SCORE ? "Great prompt!" :
           s >= POPUP_MID_SCORE ? "Decent \u2014 room to improve" :
                    "Needs work";
  }
  function scoreColor(s) { return s >= HIGH_SCORE ? "#4ade80" : s >= POPUP_MID_SCORE ? "#fbbf24" : "#f87171"; }
  function improvedLabel(s) { return s >= HIGH_SCORE ? "\uD83D\uDCA1 Optional tweak" : "\u26a1 Improved version"; }
  function useButtonLabel() { return "\u2713 Use this prompt"; }

  // ─── FIND INPUT ELEMENT ───────────────
  // Finds the currently active input — prioritizes edit boxes over the main input
  function findInputElement() {
    const platform = detectPlatform();

    if (platform === "claude") {
      // Check for an active edit box first (user editing a previous message)
      // Edit boxes appear inside the message area, not in the bottom composer
      const mainComposer = document.querySelector('div[contenteditable="true"].ProseMirror') ||
                           document.querySelector('div.ProseMirror[contenteditable="true"]') ||
                           document.querySelector('fieldset div[contenteditable="true"]');
      const allEditable = document.querySelectorAll('div[contenteditable="true"]');
      for (const el of allEditable) {
        // Skip the main composer — we want to find edit boxes
        if (el === mainComposer || (mainComposer && mainComposer.contains(el))) continue;
        if (el.closest("fieldset")) continue; // Also skip composer area

        const rect = el.getBoundingClientRect();
        // Edit box must be visible, reasonably wide, and have content
        const isVisible = rect.width > 150 && rect.height > 20;
        const hasContent = (el.innerText || "").trim().length > 0;
        const isFocused = document.activeElement === el || el.contains(document.activeElement);

        // If focused and has content — it's an edit box
        if (isVisible && hasContent && isFocused) {
          return el;
        }
      }
      // Fall back to main composer
      return mainComposer || document.querySelector('div[contenteditable="true"]');
    }

    if (platform === "chatgpt") {
      return document.querySelector('#prompt-textarea') ||
             document.querySelector('div[id="prompt-textarea"]') ||
             document.querySelector('textarea[data-id]') ||
             document.querySelector('div[contenteditable="true"][data-placeholder]');
    }

    if (platform === "gemini") {
      // Gemini uses a rich text editor with .ql-editor or contenteditable
      return document.querySelector('.ql-editor[contenteditable="true"]') ||
             document.querySelector('div[contenteditable="true"][aria-label*="prompt"]') ||
             document.querySelector('div[contenteditable="true"][aria-label*="Enter"]') ||
             document.querySelector('div[contenteditable="true"][role="textbox"]') ||
             document.querySelector('rich-textarea div[contenteditable="true"]') ||
             document.querySelector('.input-area div[contenteditable="true"]') ||
             // Broader fallback — find contenteditable in the bottom area of the page
             (() => {
               const all = document.querySelectorAll('div[contenteditable="true"]');
               for (const el of all) {
                 const rect = el.getBoundingClientRect();
                 // Input is usually in the bottom half of the page and reasonably wide
                 if (rect.top > window.innerHeight * 0.3 && rect.width > 200) {
                   return el;
                 }
               }
               return null;
             })();
    }

    return null;
  }

  function getInputText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value.trim();
    return (el.innerText || el.textContent || "").trim();
  }

  function setInputText(el, text) {
    if (!el) return;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set ||
                           Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.focus();
      // Select all existing content and replace
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ─── FIND CONTAINER — platform-aware ───
  // Returns the narrowest meaningful ancestor around the input.
  // On Gemini, `[class*="prompt"]` matches a full-viewport-width wrapper,
  // which breaks right-side popup placement. This walks up the tree to find
  // a container narrower than 80% of the viewport.
  function findContainer(inputEl) {
    if (!inputEl) return null;

    const generic = inputEl.closest('form, fieldset, [class*="composer"], [class*="input-area"], [class*="prompt"]');

    // Quick sanity check: if the matched container is reasonably scoped, use it
    if (generic) {
      const r = generic.getBoundingClientRect();
      if (r.width > 0 && r.width < window.innerWidth * 0.8) return generic;
    }

    // Container is too wide (Gemini case) — walk up and find the tightest
    // ancestor that is: (a) > 200px wide, (b) < 80% viewport, (c) visible
    let best = null;
    let el = inputEl.parentElement;
    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.width < window.innerWidth * 0.8 && r.height > 0) {
        // Pick the outermost one that's still < 80% viewport
        // (gives the most "chat column"-like bounding box)
        best = el;
      }
      el = el.parentElement;
    }

    return best || generic || inputEl.parentElement;
  }

  // ─── POSITION BADGE RELATIVE TO INPUT ─
  // Uses fixed positioning based on input's bounding rect
  function positionBadge() {
    if (!badge || !activeInputEl) return;
    const rect = activeInputEl.getBoundingClientRect();
    // Find the outer container (form, fieldset, or parent with border)
    let container = findContainer(activeInputEl);
    const containerRect = container ? container.getBoundingClientRect() : rect;

    badge.style.position = "fixed";
    // Position badge above container, but never behind sticky headers (keep at least 8px from top)
    const badgeTop = Math.max(8, containerRect.top - 20);
    badge.style.top = badgeTop + "px";
    badge.style.right = (window.innerWidth - containerRect.right + 12) + "px";
    badge.style.left = "auto";
    badge.style.bottom = "auto";
  }

  function positionPopup() {
    if (!popup || !activeInputEl) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;

    popup.style.position = "fixed";
    popup.style.maxHeight = "80vh";
    popup.style.overflowY = "auto";
    popup.style.right = "auto";
    popup.style.bottom = "auto";

    // If user has dragged, use their position (clamped to viewport)
    if (userDragPos) {
      const pw = popup.offsetWidth || 400;
      const ph = popup.offsetHeight || 400;
      popup.style.left = Math.max(8, Math.min(userDragPos.left, vw - pw - 8)) + "px";
      popup.style.top = Math.max(8, Math.min(userDragPos.top, vh - ph - 8)) + "px";
      return;
    }

    // ── Viewport-relative sizing — works at any zoom level ──
    // Desired width: 38% of viewport, clamped between 360–640px
    const desiredW = Math.round(Math.min(Math.max(vw * 0.38, 360), 640));
    // On very narrow viewports (mobile / extreme zoom), use almost full width
    const popupW = Math.min(desiredW, vw - margin * 2);

    // Try to place NEXT TO the chat container (right side) if there's room
    const container = findContainer(activeInputEl);
    const containerRect = container ? container.getBoundingClientRect() : activeInputEl.getBoundingClientRect();
    const spaceRight = vw - containerRect.right;

    if (spaceRight >= popupW + margin * 2) {
      // Fits to the right of the chat column — ideal
      popup.style.left = (containerRect.right + margin) + "px";
      popup.style.width = popupW + "px";
    } else {
      // Doesn't fit next to chat — anchor to RIGHT EDGE of viewport
      // This keeps the popup out of the way of the chat content on the left
      popup.style.left = (vw - popupW - margin) + "px";
      popup.style.width = popupW + "px";
    }

    // Vertical: center on input, clamped to viewport
    const popupH = Math.min(popup.scrollHeight || 500, vh * 0.8);
    let topPos = containerRect.top + (containerRect.height / 2) - (popupH / 2);
    topPos = Math.max(margin, Math.min(topPos, vh - popupH - margin));
    popup.style.top = topPos + "px";
  }

  function positionOnboarding() {
    if (!onboarding || !activeInputEl) return;
    let container = findContainer(activeInputEl);
    const containerRect = container ? container.getBoundingClientRect() : activeInputEl.getBoundingClientRect();
    const rightOffset = window.innerWidth - containerRect.right + 12;

    onboarding.style.position = "fixed";
    onboarding.style.right = rightOffset + "px";
    onboarding.style.left = "auto";
    // Position above the input container, clamped to viewport
    const obHeight = onboarding.offsetHeight || 280;
    const topPos = Math.max(12, containerRect.top - obHeight - 12);
    onboarding.style.top = topPos + "px";
    onboarding.style.bottom = "auto";
  }

  // ─── CREATE BADGE ─────────────────────
  function createBadge() {
    if (badge) return badge;
    badge = document.createElement("div");
    badge.className = `pi-badge pi-${detectTheme()} pi-hidden`;
    badge.innerHTML = `
      <span class="pi-badge-dot pi-dot-mid" id="pi-badge-dot"></span>
      <span class="pi-badge-text" id="pi-badge-text"></span>
    `;
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (isOnboardingOpen) return;
      if (isPopupOpen) closePopup();
      else openPopup();
    });
    document.body.appendChild(badge);
    return badge;
  }

  // ─── CREATE POPUP ─────────────────────
  function createPopup() {
    if (popup) return popup;
    popup = document.createElement("div");
    popup.className = `pi-popup pi-${detectTheme()}`;
    popup.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(popup);
    initPopupDrag();
    return popup;
  }

  // ─── POPUP DRAG-TO-REPOSITION ─────────
  function initPopupDrag() {
    if (!popup) return;
    const DRAG_THRESHOLD = 5; // px before drag activates (protects close button clicks)

    function onPointerDown(e) {
      // Only drag from the header, and not from the close button
      const header = popup.querySelector(".pi-popup-header");
      if (!header || !header.contains(e.target)) return;
      if (e.target.closest(".pi-popup-close")) return;

      const rect = popup.getBoundingClientRect();
      dragStart = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        popupLeft: rect.left,
        popupTop: rect.top,
      };
      // Don't set isDragging yet — wait for threshold
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
      // Prevent text selection on the page while potentially dragging
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!dragStart) return;
      const dx = e.clientX - dragStart.mouseX;
      const dy = e.clientY - dragStart.mouseY;

      // Activate drag only after exceeding threshold
      if (!isDragging && (Math.abs(dx) >= DRAG_THRESHOLD || Math.abs(dy) >= DRAG_THRESHOLD)) {
        isDragging = true;
        popup.classList.add("pi-dragging");
      }

      if (!isDragging) return;

      // Throttle to animation frame
      if (dragRafId) cancelAnimationFrame(dragRafId);
      dragRafId = requestAnimationFrame(() => {
        if (!popup) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pw = popup.offsetWidth || 400;
        const ph = popup.offsetHeight || 400;

        let newLeft = dragStart.popupLeft + dx;
        let newTop = dragStart.popupTop + dy;

        // Clamp to viewport (keep at least 40px visible)
        newLeft = Math.max(-pw + 40, Math.min(newLeft, vw - 40));
        newTop = Math.max(0, Math.min(newTop, vh - 40));

        popup.style.left = newLeft + "px";
        popup.style.top = newTop + "px";
        popup.style.right = "auto";
        popup.style.bottom = "auto";
      });
    }

    function onPointerUp(e) {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = null; }

      if (isDragging) {
        // Save the position so positionPopup() uses it
        const rect = popup.getBoundingClientRect();
        userDragPos = { left: rect.left, top: rect.top };
        popup.classList.remove("pi-dragging");
      }
      isDragging = false;
      dragStart = null;
    }

    popup.addEventListener("pointerdown", onPointerDown);
  }

  // ─── CREATE ONBOARDING ────────────────
  function createOnboarding() {
    if (onboarding) return onboarding;
    onboarding = document.createElement("div");
    onboarding.className = `pi-onboarding pi-${detectTheme()}`;
    onboarding.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(onboarding);
    return onboarding;
  }

  function renderOnboarding(freeRemaining) {
    const ob = createOnboarding();
    const theme = detectTheme();
    ob.className = `pi-onboarding pi-${theme}`;
    ob.innerHTML = `
      <div class="pi-onboarding-inner">
        <div class="pi-onboarding-title">\u2728 PromptPulse</div>
        <div class="pi-onboarding-sub">Score and improve your prompts instantly.</div>
        <div class="pi-onboarding-free">
          <span>\u26a1</span>
          <span>${freeRemaining} free ${freeRemaining === 1 ? "analysis" : "analyses"} remaining \u2014 no key needed</span>
        </div>
        <div class="pi-onboarding-label">API Key (optional \u2014 for unlimited use)</div>
        <input type="password" class="pi-onboarding-input" id="pi-ob-key" placeholder="sk-ant-... or sk-... or AIza..." />
        <div class="pi-onboarding-detected pi-detected-none" id="pi-ob-detected"></div>
        <a class="pi-help-link" id="pi-ob-help">\uD83D\uDD11 How to get your API key →</a>
        <button class="pi-onboarding-save" id="pi-ob-save">Save & Start</button>
        <button class="pi-onboarding-skip" id="pi-ob-skip">Skip \u2014 use free analyses</button>
      </div>
    `;

    positionOnboarding();

    const keyInput = ob.querySelector("#pi-ob-key");
    const detected = ob.querySelector("#pi-ob-detected");
    const saveBtn = ob.querySelector("#pi-ob-save");
    const skipBtn = ob.querySelector("#pi-ob-skip");

    ob.querySelector("#pi-ob-help").addEventListener("click", (e) => { e.stopPropagation(); openApiKeyHelp(); });

    keyInput.addEventListener("input", () => {
      const val = keyInput.value.trim();
      if (!val) { detected.textContent = ""; detected.className = "pi-onboarding-detected pi-detected-none"; saveBtn.textContent = "Save & Start"; return; }
      let provider = null;
      if (val.startsWith("sk-ant-")) provider = "Anthropic (Claude)";
      else if (val.startsWith("AIza")) provider = "Google (Gemini)";
      else if (val.startsWith("sk-")) provider = "OpenAI (ChatGPT)";
      if (provider) { detected.textContent = `\u2713 Detected: ${provider}`; detected.className = "pi-onboarding-detected pi-detected-ok"; saveBtn.textContent = `Save ${provider} Key`; }
      else { detected.textContent = "Unrecognized key format"; detected.className = "pi-onboarding-detected pi-detected-none"; }
    });

    saveBtn.addEventListener("click", () => {
      const key = keyInput.value.trim();
      if (key) {
        chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey: key }, (res) => {
          if (chrome.runtime.lastError) { detected.textContent = "Extension error — try reloading page"; detected.className = "pi-onboarding-detected pi-detected-none"; return; }
          if (res?.success) { closeOnboarding(); showBadgeForCurrentInput(); }
          else { detected.textContent = res?.error || "Failed to save key"; detected.className = "pi-onboarding-detected pi-detected-none"; }
        });
      } else { closeOnboarding(); showBadgeForCurrentInput(); }
    });

    skipBtn.addEventListener("click", () => { closeOnboarding(); showBadgeForCurrentInput(); });
    return ob;
  }

  // ─── ATTACH TO INPUT ──────────────────
  const attachedElements = new WeakSet(); // Prevent duplicate listeners
  const attachedSendContainers = new WeakSet(); // Prevent duplicate send button listeners

  function attachToInput(inputEl) {
    if (!inputEl) return;
    activeInputEl = inputEl;

    createBadge();
    createPopup();

    // Only add event listeners once per element
    if (attachedElements.has(inputEl)) return;
    attachedElements.add(inputEl);

    const handleInput = () => {
      // Only process if this is still the active element
      if (activeInputEl !== inputEl) return;
      clearTimeout(debounceTimer);
      const text = getInputText(inputEl);
      if (text.length < MIN_PROMPT_LENGTH) { hideBadge(); return; }
      debounceTimer = setTimeout(() => {
        if (activeInputEl !== inputEl) return;
        const currentText = getInputText(inputEl);
        if (currentText === lastAnalyzedText) return;
        lastAnalyzedText = currentText;
        const score = quickScore(currentText);
        currentScore = score;
        showBadge(score);
      }, DEBOUNCE_MS);
    };

    inputEl.addEventListener("input", handleInput);
    if (inputEl.getAttribute("contenteditable") === "true") {
      inputEl.addEventListener("keyup", handleInput);
    }

    // Detect send — hide badge when input is cleared after submission
    const checkAndHide = () => {
      if (activeInputEl !== inputEl) return;
      const text = getInputText(inputEl);
      if (text.length < MIN_PROMPT_LENGTH) {
        hideBadge();
        lastAnalyzedText = "";
      }
    };

    // Enter key (works on Claude, ChatGPT; on Gemini Enter = newline but we still check)
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        // Check multiple times — platforms clear input at different speeds
        setTimeout(checkAndHide, 100);
        setTimeout(checkAndHide, 300);
        setTimeout(checkAndHide, 800);
        setTimeout(checkAndHide, 1500);
      }
    });

    // Send button click — catches click-to-send on all platforms
    // Watch for clicks on nearby buttons/SVGs within the same form/container
    const sendContainer = inputEl.closest('form, fieldset, [class*="composer"], [class*="input-area"], [class*="prompt"]') || inputEl.parentElement?.parentElement;
    if (sendContainer && !attachedSendContainers.has(sendContainer)) {
      attachedSendContainers.add(sendContainer);
      sendContainer.addEventListener("click", (e) => {
        const target = e.target;
        // Check if click was on a button, SVG, or element that looks like a send trigger
        const isSendish = target.closest('button[aria-label*="Send"], button[aria-label*="send"], button[data-testid*="send"], button[class*="send"], button svg, [class*="send-button"]');
        if (isSendish) {
          setTimeout(checkAndHide, 200);
          setTimeout(checkAndHide, 500);
          setTimeout(checkAndHide, 1000);
          setTimeout(checkAndHide, 2000);
        }
      });
    }
  }

  // ─── BADGE SHOW/HIDE ─────────────────
  function showBadge(score) {
    if (!badge) return;
    const theme = detectTheme();
    badge.className = `pi-badge pi-${theme}`;
    const dotClass = score >= HIGH_SCORE ? "pi-dot-high" : score >= BADGE_MID_SCORE ? "pi-dot-mid" : "pi-dot-low";
    badge.querySelector(".pi-badge-dot").className = `pi-badge-dot ${dotClass}`;
    badge.querySelector(".pi-badge-text").textContent = badgeLabel(score);
    positionBadge();

    // Track input position as it moves + auto-hide if input cleared (e.g. after send)
    if (positionInterval) clearInterval(positionInterval);
    positionInterval = setInterval(() => {
      positionBadge();
      // Auto-hide if the input was cleared (user sent the message)
      if (activeInputEl) {
        const text = getInputText(activeInputEl);
        if (text.length < MIN_PROMPT_LENGTH) {
          hideBadge();
          lastAnalyzedText = "";
        }
      }
    }, 300); // 300ms — fast enough to catch send on any platform
  }

  function hideBadge() {
    if (badge) badge.className = `pi-badge pi-${detectTheme()} pi-hidden`;
    if (positionInterval) { clearInterval(positionInterval); positionInterval = null; }
    closePopup();
  }

  function showBadgeForCurrentInput() {
    const inputEl = findInputElement();
    if (!inputEl) return;
    activeInputEl = inputEl;
    const text = getInputText(inputEl);
    if (text.length >= MIN_PROMPT_LENGTH) {
      const score = quickScore(text);
      currentScore = score;
      lastAnalyzedText = text;
      showBadge(score);
    }
  }

  // ─── CELEBRATION TOAST (R3) ──────────
  function showCelebrationToast() {
    // Only show once per page load — after that the green badge is enough
    if (hasShownCelebration) return;
    hasShownCelebration = true;
    // Use rAF to ensure badge has reflowed after unfading (closePopup just ran)
    requestAnimationFrame(() => {
      const theme = detectTheme();
      const toast = document.createElement("div");
      toast.className = `pi-toast pi-${theme}`;
      toast.innerHTML = `<span>\uD83C\uDF89</span> Prompt upgraded!`;
      // Position near the badge
      if (badge) {
        const badgeRect = badge.getBoundingClientRect();
        toast.style.top = (badgeRect.top - 44) + "px";
        toast.style.right = (window.innerWidth - badgeRect.right) + "px";
      } else {
        toast.style.top = "20px";
        toast.style.right = "20px";
      }
      document.body.appendChild(toast);
      setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 3000);
    });
  }

  // ─── POPUP OPEN/CLOSE ────────────────
  function openPopup() {
    if (!popup || isPopupOpen) return;
    isPopupOpen = true;

    // R1: Fade badge while popup is visible — avoids competing color signals
    if (badge) badge.classList.add("pi-badge-faded");

    const theme = detectTheme();
    popup.className = `pi-popup pi-${theme} pi-show`;
    positionPopup();

    popup.innerHTML = `
      <div class="pi-popup-header">
        <div class="pi-popup-title"><span>\u2728</span> PromptPulse</div>
        <button class="pi-popup-close" id="pi-popup-close">\u00d7</button>
      </div>
      <div class="pi-popup-body">
        <div class="pi-popup-loading">
          <div class="pi-spinner"></div>
          <div class="pi-popup-loading-text">Analyzing your prompt...</div>
        </div>
      </div>
    `;
    popup.querySelector("#pi-popup-close").addEventListener("click", (e) => { e.stopPropagation(); closePopup(); });

    const inputEl = findInputElement();
    const text = getInputText(inputEl);

    // If same prompt text was already analyzed, reuse cached result (no API call)
    if (cachedResult && text === cachedPromptText) {
      currentResult = cachedResult;
      renderPopupResult(cachedResult);
      return;
    }

    chrome.runtime.sendMessage({ type: "IMPROVE_PROMPT", prompt: text }, (res) => {
      if (chrome.runtime.lastError) { if (isPopupOpen) renderPopupError("Extension error — try reloading the page"); return; }
      if (!isPopupOpen) return;
      if (res?.success) {
        currentResult = res.data;
        cachedPromptText = text;
        cachedResult = res.data;
        renderPopupResult(res.data, res.freeRemaining);
      }
      else if (res?.error === "FREE_LIMIT_REACHED") renderPopupLimitReached();
      else renderPopupError(res?.error || res?.message || "Something went wrong");
    });
  }

  function closePopup() {
    if (popup) popup.classList.remove("pi-show", "pi-dragging");
    isPopupOpen = false;
    userDragPos = null; // Reset drag so next open gets fresh auto-position
    isDragging = false;
    dragStart = null;
    // R1: Unfade badge and update with latest score (API score if available)
    if (badge) badge.classList.remove("pi-badge-faded");
    // Only re-show badge if input still has enough text (avoids flash after send)
    const text = activeInputEl ? getInputText(activeInputEl) : "";
    if (currentScore !== null && text.length >= MIN_PROMPT_LENGTH) showBadge(currentScore);
  }

  function renderPopupResult(data, freeRemaining) {
    const theme = detectTheme();
    const score = data.score || currentScore;
    const color = scoreColor(score);
    // R1: Store API score — badge is faded while popup is open, updates on close
    currentScore = score;

    // Build severity-tagged issues HTML
    let issuesHtml = "";
    if (data.issues?.length) {
      const items = data.issues.map(issue => {
        // Issues come as { text, severity } objects from the API
        // Fall back to string format for backward compatibility
        let text, severity;
        if (typeof issue === "object" && issue.text) {
          text = escapeHtml(issue.text);
          severity = issue.severity || "medium";
        } else {
          text = escapeHtml(String(issue));
          severity = "medium";
        }
        return `<div class="pi-issue-item pi-sev-${severity}"><span class="pi-issue-dot"></span> ${text}</div>`;
      });
      issuesHtml = `<div class="pi-issue-list">${items.join("")}</div>`;
    }

    let freeHtml = "";
    if (freeRemaining !== undefined && freeRemaining >= 0) {
      freeHtml = `<div class="pi-popup-free-count">${freeRemaining} free ${freeRemaining === 1 ? "analysis" : "analyses"} remaining</div>`;
    }

    popup.innerHTML = `
      <div class="pi-popup-header">
        <div class="pi-popup-title"><span>\u2728</span> PromptPulse</div>
        <button class="pi-popup-close" id="pi-popup-close">\u00d7</button>
      </div>
      <div class="pi-popup-body">
        <div class="pi-score-banner ${scoreBannerClass(score)}">
          <div class="pi-score-banner-num">${score}<span>/10</span></div>
          <div class="pi-score-banner-right">
            <div class="pi-score-banner-title">${scoreLabelBanner(score)}</div>
            <div class="pi-score-banner-bar"><div class="pi-score-banner-bar-fill" style="width:${score * 10}%;background:${color}"></div></div>
          </div>
        </div>
        ${issuesHtml}
        <div class="pi-popup-divider"></div>
        <div class="pi-popup-improved"${score >= HIGH_SCORE ? ' style="opacity:0.7"' : ''}>
          <div class="pi-popup-improved-label">${improvedLabel(score)}</div>
          <div class="pi-popup-improved-text">${escapeHtml(data.improved || "")}</div>
        </div>
        ${score >= HIGH_SCORE
          ? `<div class="pi-popup-btns">
              <button class="pi-popup-btn pi-btn-primary" id="pi-keep-btn">\uD83D\uDC4D Looks great, keep mine</button>
              <button class="pi-popup-btn pi-btn-secondary" id="pi-use-btn">Apply tweak</button>
            </div>`
          : `<div class="pi-popup-btns">
              <button class="pi-popup-btn pi-btn-primary" id="pi-use-btn">${useButtonLabel(score)}</button>
              <button class="pi-popup-btn pi-btn-secondary" id="pi-keep-btn">Keep mine</button>
            </div>`
        }
        ${freeHtml}
        <div class="pi-popup-footer-nudge" id="pi-nudge" style="display:none;"></div>
      </div>
    `;

    // Re-position after content renders (content is taller than loading spinner)
    // Only auto-reposition if user hasn't dragged the popup
    if (!userDragPos) requestAnimationFrame(() => positionPopup());

    // Populate nudge footer — async
    renderNudgeFooter();

    // Track analysis (not applied) for savings dashboard
    trackStat(data.score || currentScore, data.improved_score || null);

    popup.querySelector("#pi-popup-close").addEventListener("click", (e) => { e.stopPropagation(); closePopup(); });
    popup.querySelector("#pi-keep-btn").addEventListener("click", (e) => { e.stopPropagation(); closePopup(); });
    popup.querySelector("#pi-use-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const inputEl = findInputElement();
      const origScore = data.score || currentScore;
      const improvedScore = data.improved_score || Math.max(HIGH_SCORE, quickScore(data.improved || ""));
      if (inputEl && data.improved) {
        setInputText(inputEl, data.improved);
        const actualDomText = getInputText(inputEl);
        lastAnalyzedText = actualDomText;
        currentScore = Math.max(HIGH_SCORE, quickScore(actualDomText));
        cachedPromptText = "";
        cachedResult = null;
      }
      // Mark the last stat entry as applied (don't create a new one)
      markLastStatApplied(improvedScore);
      closePopup();
      showCelebrationToast();
    });
  }

  function openApiKeyHelp() {
    const helpUrl = chrome.runtime.getURL("api-key-help.html");
    window.open(helpUrl, "_blank");
  }

  function renderPopupLimitReached() {
    popup.innerHTML = `
      <div class="pi-popup-header">
        <div class="pi-popup-title"><span>\u2728</span> PromptPulse</div>
        <button class="pi-popup-close" id="pi-popup-close">\u00d7</button>
      </div>
      <div class="pi-popup-body">
        <div class="pi-limit-msg">
          You've used all your free analyses.<br/>
          <a id="pi-add-key-link">Add your API key</a> for unlimited use.
        </div>
        <div class="pi-onboarding-label">Paste your API key</div>
        <input type="password" class="pi-onboarding-input" id="pi-limit-key" placeholder="sk-ant-... or sk-... or AIza..." />
        <div class="pi-onboarding-detected pi-detected-none" id="pi-limit-detected"></div>
        <a class="pi-help-link" id="pi-limit-help">\uD83D\uDD11 How to get your API key →</a>
        <button class="pi-onboarding-save" id="pi-limit-save">Save & Continue</button>
      </div>
    `;
    popup.querySelector("#pi-popup-close").addEventListener("click", (e) => { e.stopPropagation(); closePopup(); });
    popup.querySelector("#pi-add-key-link").addEventListener("click", (e) => { e.stopPropagation(); openApiKeyHelp(); });
    popup.querySelector("#pi-limit-help").addEventListener("click", (e) => { e.stopPropagation(); openApiKeyHelp(); });

    const keyInput = popup.querySelector("#pi-limit-key");
    const detected = popup.querySelector("#pi-limit-detected");
    const saveBtn = popup.querySelector("#pi-limit-save");

    keyInput.addEventListener("input", () => {
      const val = keyInput.value.trim();
      let provider = null;
      if (val.startsWith("sk-ant-")) provider = "Anthropic (Claude)";
      else if (val.startsWith("AIza")) provider = "Google (Gemini)";
      else if (val.startsWith("sk-")) provider = "OpenAI (ChatGPT)";
      if (provider) { detected.textContent = `\u2713 Detected: ${provider}`; detected.className = "pi-onboarding-detected pi-detected-ok"; }
      else if (val) { detected.textContent = "Unrecognized key format"; detected.className = "pi-onboarding-detected pi-detected-none"; }
    });

    saveBtn.addEventListener("click", () => {
      const key = keyInput.value.trim();
      if (!key) return;
      chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey: key }, (res) => {
        if (chrome.runtime.lastError) { detected.textContent = "Extension error — try reloading page"; detected.className = "pi-onboarding-detected pi-detected-none"; return; }
        if (res?.success) { closePopup(); setTimeout(() => openPopup(), 300); }
        else { detected.textContent = res?.error || "Failed to save"; detected.className = "pi-onboarding-detected pi-detected-none"; }
      });
    });
  }

  function renderPopupError(errorMsg) {
    popup.innerHTML = `
      <div class="pi-popup-header">
        <div class="pi-popup-title"><span>\u2728</span> PromptPulse</div>
        <button class="pi-popup-close" id="pi-popup-close">\u00d7</button>
      </div>
      <div class="pi-popup-body">
        <div class="pi-limit-msg">${escapeHtml(errorMsg)}</div>
        <div class="pi-popup-btns">
          <button class="pi-popup-btn pi-btn-primary" id="pi-retry-btn">Retry</button>
          <button class="pi-popup-btn pi-btn-secondary" id="pi-close-btn">Close</button>
        </div>
      </div>
    `;
    popup.querySelector("#pi-popup-close").addEventListener("click", (e) => { e.stopPropagation(); closePopup(); });
    popup.querySelector("#pi-close-btn").addEventListener("click", (e) => { e.stopPropagation(); closePopup(); });
    popup.querySelector("#pi-retry-btn").addEventListener("click", (e) => { e.stopPropagation(); closePopup(); setTimeout(openPopup, 100); });
  }

  // ─── ONBOARDING FLOW ─────────────────
  function showOnboarding() {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.hasKey) { showBadgeForCurrentInput(); return; }
      isOnboardingOpen = true;
      renderOnboarding(res?.freeRemaining ?? 3);
    });
  }

  function closeOnboarding() {
    if (onboarding) onboarding.style.display = "none";
    isOnboardingOpen = false;
    chrome.storage.local.set({ onboardingShown: true });
  }

  // ─── UTILS ────────────────────────────
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── NUDGE FOOTER (Plant → Grow → Reward) ──
  function renderNudgeFooter() {
    const nudge = document.getElementById("pi-nudge");
    if (!nudge) return;
    chrome.runtime.sendMessage({ type: "GET_STATS" }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      const totalApplied = res.totalApplied || 0;
      const theme = detectTheme();
      const isDark = theme === "dark";

      if (totalApplied === 0) {
        // No data yet — don't show
        return;
      } else if (totalApplied === 1) {
        // Seed banner: first improvement
        nudge.style.display = "block";
        nudge.innerHTML = `<span style="opacity:0.6">\uD83C\uDF31</span> Nice! Your first improved prompt. <span id="pi-nudge-dash" style="color:${isDark ? '#38bdf8' : '#0ea5e9'};cursor:pointer;text-decoration:underline;">Track your savings →</span>`;
      } else {
        // Growing: show stats
        const stats = res.stats || [];
        const applied = stats.filter(s => s.applied && s.originalScore <= 7 && s.improvedScore > s.originalScore);
        let totalTimeSec = 0;
        for (const s of applied) {
          const before = FOLLOWUP_MAP[Math.max(1, Math.min(10, Math.round(s.originalScore)))] || 0;
          const after = FOLLOWUP_MAP[Math.max(1, Math.min(10, Math.round(s.improvedScore)))] || 0;
          totalTimeSec += Math.max(0, before - after) * 90;
        }
        const timeStr = totalTimeSec < 60 ? totalTimeSec + "s" : Math.round(totalTimeSec / 60) + " min";
        nudge.style.display = "block";
        nudge.innerHTML = `<span style="opacity:0.6">\uD83D\uDCCA</span> ${totalApplied} improved \u00b7 ~${timeStr} saved <span id="pi-nudge-dash" style="color:${isDark ? '#38bdf8' : '#0ea5e9'};cursor:pointer;text-decoration:underline;">Dashboard →</span>`;
      }

      // Wire up dashboard link
      setTimeout(() => {
        const dashLink = document.getElementById("pi-nudge-dash");
        if (dashLink) {
          dashLink.addEventListener("click", (e) => {
            e.stopPropagation();
            window.open(chrome.runtime.getURL("dashboard.html"), "_blank");
          });
        }
      }, 50);
    });
  }

  // ─── STATS TRACKING ─────────────────
  function trackStat(originalScore, improvedScore) {
    const platform = detectPlatform();
    const stat = {
      timestamp: Date.now(),
      platform,
      originalScore,
      improvedScore: improvedScore || originalScore,
      applied: false,
    };
    chrome.runtime.sendMessage({ type: "TRACK_STAT", stat }, (res) => {
      if (chrome.runtime.lastError) return;
    });
  }

  function markLastStatApplied(improvedScore) {
    chrome.runtime.sendMessage({ type: "MARK_APPLIED", improvedScore }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.totalApplied) {
        checkMilestone(res.totalApplied);
      }
    });
  }

  function checkMilestone(totalApplied) {
    chrome.runtime.sendMessage({ type: "GET_STATS" }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      const lastShown = res.lastMilestoneShown || 0;

      // Find next milestone
      let nextMilestone = null;
      for (const m of MILESTONES) {
        if (totalApplied >= m && m > lastShown) { nextMilestone = m; }
      }
      // For 100+, check every 100
      if (totalApplied >= 100) {
        const hundreds = Math.floor(totalApplied / 100) * 100;
        if (hundreds > lastShown) nextMilestone = hundreds;
      }

      if (!nextMilestone) return;

      // Check minimum time threshold
      const stats = res.stats || [];
      const firstTimestamp = stats.length > 0 ? stats[0].timestamp : Date.now();
      const secsSinceStart = (Date.now() - firstTimestamp) / 1000;
      const minTime = MILESTONE_MIN_TIME[nextMilestone] || 0;
      if (secsSinceStart < minTime) return;

      // Show milestone toast
      chrome.runtime.sendMessage({ type: "SET_MILESTONE", milestone: nextMilestone });
      showMilestoneToast(nextMilestone, res.stats);
    });
  }

  function showMilestoneToast(milestone, stats) {
    // Calculate time saved for toast message
    const applied = (stats || []).filter(s => s.applied && s.originalScore <= 7 && s.improvedScore > s.originalScore);
    let totalTimeSec = 0;
    for (const s of applied) {
      const before = FOLLOWUP_MAP[Math.max(1, Math.min(10, Math.round(s.originalScore)))] || 0;
      const after = FOLLOWUP_MAP[Math.max(1, Math.min(10, Math.round(s.improvedScore)))] || 0;
      totalTimeSec += Math.max(0, before - after) * 90;
    }
    const timeStr = totalTimeSec < 60 ? totalTimeSec + "s" : Math.round(totalTimeSec / 60) + " min";

    const theme = detectTheme();
    const toast = document.createElement("div");
    toast.className = `pi-toast pi-${theme}`;
    toast.style.cssText = "animation: piToastIn 0.3s ease-out, piToastOut 0.4s ease-in 5.6s forwards;";
    toast.innerHTML = `<span>\uD83C\uDF89</span> ${milestone} prompts improved! ~${timeStr} saved. <span style="opacity:0.6;cursor:pointer;text-decoration:underline;" id="pi-ms-dash">View dashboard</span>`;

    // Position near top-right
    toast.style.top = "20px";
    toast.style.right = "20px";
    document.body.appendChild(toast);

    // Dashboard link
    setTimeout(() => {
      const dashLink = document.getElementById("pi-ms-dash");
      if (dashLink) {
        dashLink.addEventListener("click", () => {
          window.open(chrome.runtime.getURL("dashboard.html"), "_blank");
        });
      }
    }, 50);

    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 6000);
  }

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (isPopupOpen && popup && !popup.contains(e.target) && !badge?.contains(e.target)) closePopup();
    if (isOnboardingOpen && onboarding && !onboarding.contains(e.target)) { closeOnboarding(); showBadgeForCurrentInput(); }
  });

  // Reposition on scroll/resize
  window.addEventListener("scroll", () => { positionBadge(); if (isPopupOpen && !isDragging) positionPopup(); }, true);
  window.addEventListener("resize", () => {
    positionBadge();
    if (isPopupOpen) {
      // If user dragged, re-clamp to new viewport; otherwise auto-reposition
      if (userDragPos && popup) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pw = popup.offsetWidth || 400;
        const ph = popup.offsetHeight || 400;
        userDragPos.left = Math.max(8, Math.min(userDragPos.left, vw - pw - 8));
        userDragPos.top = Math.max(8, Math.min(userDragPos.top, vh - ph - 8));
      }
      positionPopup();
    }
  });

  // ─── INITIALIZATION ───────────────────
  function init() {
    const inputEl = findInputElement();
    if (inputEl) {
      mainComposerEl = inputEl; // Remember the main composer
      attachToInput(inputEl);
      chrome.storage.local.get(["onboardingShown"], (data) => {
        if (!data.onboardingShown) {
          const showOnce = () => { showOnboarding(); inputEl.removeEventListener("focus", showOnce); };
          inputEl.addEventListener("focus", showOnce);
          if (document.activeElement === inputEl) showOnboarding();
        }
      });
      return true;
    }
    return false;
  }

  // Retry until input is found
  if (!init()) {
    const observer = new MutationObserver(() => { if (init()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    let retries = 0;
    const retryInterval = setInterval(() => { retries++; if (init() || retries > 30) clearInterval(retryInterval); }, 1000);
  }

  // Watch for SPA navigation (NOT edit boxes — those are handled by focusin + MutationObserver)
  let lastInputEl = null;
  setInterval(() => {
    // If we're locked onto a sticky edit box, don't interfere
    if (stickyEditBox && document.body.contains(stickyEditBox)) return;

    const inputEl = findInputElement();
    if (inputEl && inputEl !== lastInputEl) {
      lastInputEl = inputEl;
      attachToInput(inputEl);
      // If this is an edit box with existing content, show badge immediately
      const text = getInputText(inputEl);
      if (text.length >= MIN_PROMPT_LENGTH) {
        lastAnalyzedText = text;
        currentScore = quickScore(text);
        showBadge(currentScore);
      }
    }
  }, 1000);

  // ─── STICKY EDIT BOX HELPERS ───────────
  // When an edit box is detected, we "lock" onto it so that the platform's
  // own focus-shifting (e.g., Gemini refocusing the main composer) doesn't
  // steal the badge away. We unlock when the edit box is removed from DOM.
  let editBoxObserver = null; // Single observer — reused, prevents leaks
  function lockEditBox(el) {
    stickyEditBox = el;
    // Disconnect previous observer if any (prevents accumulation)
    if (editBoxObserver) editBoxObserver.disconnect();
    // Watch for the edit box being removed from the DOM
    editBoxObserver = new MutationObserver(() => {
      if (!document.body.contains(el)) {
        stickyEditBox = null;
        editBoxObserver.disconnect();
        editBoxObserver = null;
        // Re-attach to the main composer
        const mainInput = findInputElement();
        if (mainInput) {
          lastInputEl = mainInput;
          activeInputEl = mainInput;
          attachToInput(mainInput);
          const text = getInputText(mainInput);
          if (text.length >= MIN_PROMPT_LENGTH) {
            lastAnalyzedText = text;
            currentScore = quickScore(text);
            showBadge(currentScore);
          } else {
            hideBadge();
          }
        }
      }
    });
    editBoxObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ─── FOCUSIN LISTENER FOR EDIT BOXES ──
  // Event-driven: catches the exact moment ANY editable element gets focus.
  // This is critical for edit boxes on Claude/Gemini which appear dynamically.
  document.addEventListener("focusin", (e) => {
    // If we're locked onto a sticky edit box that's still in the DOM, ignore other focuses
    if (stickyEditBox && document.body.contains(stickyEditBox)) return;

    const el = e.target;
    // Find the editable element: could be a contenteditable, textarea, or input
    let editable = null;
    if (el.getAttribute?.("contenteditable") === "true") {
      editable = el;
    } else if (el.closest?.('[contenteditable="true"]')) {
      editable = el.closest('[contenteditable="true"]');
    } else if (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type === "text")) {
      editable = el;
    }
    if (!editable) return;

    // Skip if we're already tracking this element
    if (editable === lastInputEl) return;

    // Skip our own extension elements
    if (editable.closest(".pi-popup, .pi-onboarding, .pi-badge")) return;

    const rect = editable.getBoundingClientRect();
    // Must be visible and reasonably sized
    if (rect.width < 100 || rect.height < 15) return;

    const text = getInputText(editable);

    // Attach to this element
    lastInputEl = editable;
    activeInputEl = editable;
    attachToInput(editable);

    if (text.length >= MIN_PROMPT_LENGTH) {
      lastAnalyzedText = text;
      currentScore = quickScore(text);
      showBadge(currentScore);
      // If this element already has content AND it's not the main composer,
      // it's an edit box. Lock onto it so the platform's focus-shifting doesn't steal the badge.
      if (editable !== mainComposerEl && !mainComposerEl?.contains(editable)) {
        lockEditBox(editable);
      }
    }
  }, true); // Use capture phase to catch focus before it bubbles

  // Also watch for new contenteditable/textarea elements via MutationObserver
  // This catches when Claude/Gemini injects an edit box into the DOM
  const newEditableObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Skip our own elements
        if (node.closest?.(".pi-popup, .pi-onboarding, .pi-badge")) continue;

        // Check if the added node is or contains an editable
        const editables = [];
        if (node.getAttribute?.("contenteditable") === "true") editables.push(node);
        if (node.tagName === "TEXTAREA") editables.push(node);
        if (node.querySelectorAll) {
          editables.push(...node.querySelectorAll('[contenteditable="true"]'));
          editables.push(...node.querySelectorAll("textarea"));
        }
        for (const editable of editables) {
          if (editable === lastInputEl) continue;
          if (editable.closest?.(".pi-popup, .pi-onboarding, .pi-badge")) continue;
          const rect = editable.getBoundingClientRect();
          const text = getInputText(editable);
          // If it has content and is visible, it's an edit box that just appeared
          // Lock onto it so the platform can't steal focus away
          if (text.length >= MIN_PROMPT_LENGTH && rect.width > 100) {
            lastInputEl = editable;
            activeInputEl = editable;
            attachToInput(editable);
            lastAnalyzedText = text;
            currentScore = quickScore(text);
            showBadge(currentScore);
            lockEditBox(editable); // Lock — don't let focus shift steal the badge
          }
        }
      }
    }
  });
  newEditableObserver.observe(document.body, { childList: true, subtree: true });

})();
