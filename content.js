// content.js
// Injects a floating action button on the Adobe Stock Contributor page,
// finds the currently selected asset's image, sends it to the
// background script for Gemini analysis, and fills in the resulting
// Title and Keywords fields.

(function () {
  const BUTTON_ID = "asm-ai-fab";
  const STATUS_ID = "asm-ai-status";

  // ---------- UI: floating button + status pill ----------

  function injectStyles() {
    if (document.getElementById("asm-ai-styles")) return;
    const style = document.createElement("style");
    style.id = "asm-ai-styles";
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed;
        bottom: 28px;
        right: 28px;
        z-index: 2147483647;
        background: #1473e6;
        color: #fff;
        border: none;
        border-radius: 999px;
        padding: 14px 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        font-weight: 600;
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: transform 0.15s ease, background 0.15s ease;
      }
      #${BUTTON_ID}:hover { background: #0d66d0; transform: translateY(-2px); }
      #${BUTTON_ID}:disabled { background: #8ba9c9; cursor: wait; transform: none; }
      #${BUTTON_ID} .asm-spinner {
        width: 14px; height: 14px;
        border: 2px solid rgba(255,255,255,0.4);
        border-top-color: #fff;
        border-radius: 50%;
        animation: asm-spin 0.7s linear infinite;
        display: none;
      }
      #${BUTTON_ID}.loading .asm-spinner { display: inline-block; }
      #${BUTTON_ID}.loading .asm-label::after { content: "Generating..."; }
      #${BUTTON_ID}.loading .asm-label { font-size: 0; }
      #${BUTTON_ID}.loading .asm-label::after { font-size: 14px; }
      @keyframes asm-spin { to { transform: rotate(360deg); } }
      #${STATUS_ID} {
        position: fixed;
        bottom: 84px;
        right: 28px;
        z-index: 2147483647;
        max-width: 320px;
        background: #2c2c2c;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        padding: 10px 14px;
        border-radius: 8px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
        display: none;
      }
      #${STATUS_ID}.error { background: #d31510; }
      #${STATUS_ID}.success { background: #268e6c; }
      #${STATUS_ID}.visible { display: block; }
    `;
    document.head.appendChild(style);
  }

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.innerHTML = `<span class="asm-spinner"></span><span class="asm-label">✨ AI Metadata</span>`;
    btn.addEventListener("click", handleGenerateClick);
    document.body.appendChild(btn);

    const status = document.createElement("div");
    status.id = STATUS_ID;
    document.body.appendChild(status);
  }

  function setLoading(isLoading) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    btn.disabled = isLoading;
    btn.classList.toggle("loading", isLoading);
  }

  function showStatus(message, type) {
    const status = document.getElementById(STATUS_ID);
    if (!status) return;
    status.textContent = message;
    status.className = "visible" + (type ? ` ${type}` : "");
  }

  // ---------- Aggressive image finding ----------

  /**
   * Tries multiple strategies to find the currently selected asset's
   * preview image on the Adobe Stock Contributor SPA, since the DOM
   * structure varies and can change between deployments.
   */
  function findSelectedImageElement() {
    const candidateSelectors = [
      ".asset-preview img",
      "[class*='asset-preview'] img",
      "[class*='AssetPreview'] img",
      "[class*='selected'] img",
      "[data-testid*='preview'] img",
      "[data-testid*='asset'] img",
      "img[src^='blob:']",
      "img[class*='preview']",
      "img[class*='thumbnail'][class*='selected']"
    ];

    for (const selector of candidateSelectors) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) return { type: "img", element: el };
    }

    // Fall back to elements whose background-image holds the asset
    const bgSelectors = [
      ".asset-preview",
      "[class*='asset-preview']",
      "[class*='AssetPreview']",
      "[class*='selected'][class*='thumb']",
      "[data-testid*='preview']"
    ];
    for (const selector of bgSelectors) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg !== "none") {
          return { type: "background", element: el, backgroundImage: bg };
        }
      }
    }

    // Last resort: the largest visible <img> on the page (likely the
    // main preview in most single-asset-detail layouts).
    const allImages = Array.from(document.querySelectorAll("img")).filter(isVisible);
    if (allImages.length > 0) {
      allImages.sort((a, b) => rectArea(b) - rectArea(a));
      return { type: "img", element: allImages[0] };
    }

    return null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function rectArea(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  function extractUrlFromBackgroundImage(bgValue) {
    const match = bgValue.match(/url\(["']?(.*?)["']?\)/);
    return match ? match[1] : null;
  }

  /**
   * Converts an image (by URL, including blob: URLs) to a base64 string
   * and returns { base64, mimeType }. Draws through a canvas so it
   * works uniformly for blob:, http(s):, and data: URLs.
   */
  async function urlToBase64(url) {
    const response = await fetch(url);
    const blob = await response.blob();
    const mimeType = blob.type || "image/jpeg";

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const objectUrl = URL.createObjectURL(blob);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL(mimeType === "image/png" ? "image/png" : "image/jpeg", 0.92);
          const base64 = dataUrl.split(",")[1];
          URL.revokeObjectURL(objectUrl);
          resolve({ base64, mimeType: mimeType.startsWith("image/") ? mimeType : "image/jpeg" });
        } catch (err) {
          URL.revokeObjectURL(objectUrl);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Failed to load image for base64 conversion (possible CORS/tainted canvas restriction)."));
      };
      img.src = objectUrl;
    });
  }

  async function getSelectedImageAsBase64() {
    const found = findSelectedImageElement();
    if (!found) {
      throw new Error("Could not find a selected image on the page. Make sure an asset is open/selected.");
    }

    let sourceUrl;
    if (found.type === "img") {
      sourceUrl = found.element.currentSrc || found.element.src;
    } else {
      sourceUrl = extractUrlFromBackgroundImage(found.backgroundImage);
    }

    if (!sourceUrl) {
      throw new Error("Found an image element but could not resolve its source URL.");
    }

    return urlToBase64(sourceUrl);
  }

  // ---------- Aggressive input filling ----------

  /**
   * Finds an input/textarea by checking, in order: name attribute,
   * aria-label, placeholder, and finally nearby label/heading text —
   * since Adobe Stock's SPA markup can vary and doesn't always expose
   * a stable name attribute.
   */
  function findFieldByHints(hints) {
    const lowerHints = hints.map((h) => h.toLowerCase());

    const allFields = Array.from(document.querySelectorAll("input[type='text'], input:not([type]), textarea"));

    // 1. name attribute
    for (const field of allFields) {
      const name = (field.getAttribute("name") || "").toLowerCase();
      if (lowerHints.some((h) => name.includes(h))) return field;
    }

    // 2. aria-label
    for (const field of allFields) {
      const aria = (field.getAttribute("aria-label") || "").toLowerCase();
      if (lowerHints.some((h) => aria.includes(h))) return field;
    }

    // 3. placeholder
    for (const field of allFields) {
      const placeholder = (field.getAttribute("placeholder") || "").toLowerCase();
      if (lowerHints.some((h) => placeholder.includes(h))) return field;
    }

    // 4. id
    for (const field of allFields) {
      const id = (field.id || "").toLowerCase();
      if (lowerHints.some((h) => id.includes(h))) return field;
    }

    // 5. nearby label / heading text (walk up a few ancestor levels and
    // check preceding siblings / labels within that container)
    for (const field of allFields) {
      let container = field.parentElement;
      for (let depth = 0; depth < 4 && container; depth++) {
        const text = container.textContent.toLowerCase();
        if (lowerHints.some((h) => text.includes(h)) && container.querySelectorAll("input, textarea").length <= 3) {
          return field;
        }
        container = container.parentElement;
      }
    }

    return null;
  }

  /**
   * Sets a field's value using the native setter (so React's internal
   * value tracker doesn't ignore the change) and dispatches input/change
   * events so the SPA's state updates.
   */
  function setFieldValue(field, value) {
    const isTextarea = field.tagName === "TEXTAREA";
    const prototype = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, "value").set;

    field.focus();
    nativeSetter.call(field, value);

    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.blur();
  }

  function fillTitleField(title) {
    const field = findFieldByHints(["title", "content title", "asset title"]);
    if (!field) {
      throw new Error("Could not locate the Title input field on the page.");
    }
    setFieldValue(field, title);
  }

  function fillKeywordsField(keywords) {
    const field = findFieldByHints(["keyword", "keywords", "tags"]);
    if (!field) {
      throw new Error("Could not locate the Keywords input field on the page.");
    }
    setFieldValue(field, keywords);
  }

  // ---------- Main flow ----------

  async function handleGenerateClick() {
    setLoading(true);
    showStatus("Reading selected image...", null);

    try {
      const { base64, mimeType } = await getSelectedImageAsBase64();

      showStatus("Asking Gemini for a title and keywords...", null);

      const result = await chrome.runtime.sendMessage({
        type: "GENERATE_METADATA",
        base64Image: base64,
        mimeType
      });

      if (!result || !result.success) {
        const errorMessage = (result && result.error) || "Unknown error generating metadata.";
        showStatus(errorMessage, "error");
        return;
      }

      fillTitleField(result.title);
      fillKeywordsField(result.keywords);

      showStatus("Title and keywords filled in successfully.", "success");
    } catch (err) {
      showStatus(err.message || "Something went wrong.", "error");
    } finally {
      setLoading(false);
    }
  }

  // ---------- Boot ----------

  function init() {
    injectStyles();
    injectButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Re-inject the button if the SPA re-renders and strips it out.
  const observer = new MutationObserver(() => {
    if (!document.getElementById(BUTTON_ID)) {
      injectButton();
    }
  });
  observer.observe(document.body, { childList: true, subtree: false });
})();
