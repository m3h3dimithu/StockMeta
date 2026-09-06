// options.js
// Loads and saves the Gemini API key to chrome.storage.local.
// Kept as an external file (no inline scripts) to comply with the
// default Manifest V3 CSP.

const apiKeyInput = document.getElementById("apiKeyInput");
const saveButton = document.getElementById("saveButton");
const toggleVisibility = document.getElementById("toggleVisibility");
const statusMessage = document.getElementById("statusMessage");

function showStatus(message, type) {
  statusMessage.textContent = message;
  statusMessage.className = type || "";
  if (message) {
    setTimeout(() => {
      statusMessage.textContent = "";
      statusMessage.className = "";
    }, 2500);
  }
}

async function loadApiKey() {
  try {
    const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
    if (geminiApiKey) {
      apiKeyInput.value = geminiApiKey;
    }
  } catch (err) {
    showStatus(`Could not load saved key: ${err.message}`, "error");
  }
}

async function saveApiKey() {
  const value = apiKeyInput.value.trim();
  if (!value) {
    showStatus("Please enter a valid API key before saving.", "error");
    return;
  }

  try {
    await chrome.storage.local.set({ geminiApiKey: value });
    showStatus("API key saved.", "success");
  } catch (err) {
    showStatus(`Failed to save key: ${err.message}`, "error");
  }
}

function toggleKeyVisibility() {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleVisibility.textContent = isPassword ? "Hide" : "Show";
}

saveButton.addEventListener("click", saveApiKey);
toggleVisibility.addEventListener("click", toggleKeyVisibility);
document.addEventListener("DOMContentLoaded", loadApiKey);

// In case the script runs after DOMContentLoaded already fired.
if (document.readyState !== "loading") {
  loadApiKey();
}
