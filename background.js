// background.js
// Handles all communication with the Gemini API.
// Retrieves the stored API key, builds the request, and safely parses
// the response so a malformed/error payload never causes an
// "Cannot read properties of undefined (reading '0')" crash downstream.

const GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const METADATA_PROMPT = `You are an expert microstock metadata specialist who writes for Adobe Stock Contributor submissions.

Analyze the attached image and produce metadata that maximizes discoverability and sales potential on Adobe Stock.

Requirements:
1. "Title": A single, highly descriptive, natural-sounding title under 200 characters. Do not use hashtags, keyword-stuffing, or ALL CAPS. Describe the actual subject, action, setting, mood, and style visible in the image.
2. "Keywords": EXACTLY 49 relevant, comma-separated keywords, ordered from most to least relevant. Include the primary subject first, then secondary subjects, concepts, emotions, colors, composition, and style-related terms. Do not repeat words. Do not number them.

Respond with STRICT JSON only, no Markdown code fences, no commentary, no leading or trailing text — just the raw JSON object in exactly this shape:
{"Title": "...", "Keywords": "keyword1, keyword2, keyword3, ..."}`;

/**
 * Strips accidental Markdown code fences (```json ... ```) that some
 * models add despite instructions, then parses the JSON.
 */
function parseModelJson(rawText) {
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned);
}

async function getApiKey() {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  return geminiApiKey || null;
}

/**
 * Calls Gemini with the given base64 image and mime type.
 * Always resolves to { success: boolean, title?, keywords?, error? }
 * — never throws, so the caller (content.js) never hits an
 * "undefined" access.
 */
async function generateMetadata(base64Image, mimeType) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return {
      success: false,
      error: "No Gemini API key set. Open the extension's Options page and save your key first."
    };
  }

  const requestBody = {
    contents: [
      {
        parts: [
          { text: METADATA_PROMPT },
          {
            inline_data: {
              mime_type: mimeType || "image/jpeg",
              data: base64Image
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json"
    }
  };

  let res;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
  } catch (networkErr) {
    return {
      success: false,
      error: `Network error calling Gemini API: ${networkErr.message}`
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    return {
      success: false,
      error: `Gemini API returned a non-JSON response (HTTP ${res.status}).`
    };
  }

  // Fix for the "Cannot read properties of undefined (reading '0')" bug:
  // ALWAYS check res.ok and the shape of `data` before indexing into it.
  if (!res.ok) {
    const apiMessage =
      (data && data.error && data.error.message) ||
      JSON.stringify(data) ||
      `HTTP ${res.status}`;
    return {
      success: false,
      error: `Gemini API error (HTTP ${res.status}): ${apiMessage}`
    };
  }

  if (!data || !Array.isArray(data.candidates) || data.candidates.length === 0) {
    return {
      success: false,
      error: `Gemini API returned no candidates. Raw response: ${JSON.stringify(data)}`
    };
  }

  const candidate = data.candidates[0];

  // Handle candidates that were cut off by safety filters, MAX_TOKENS, etc.
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    // Still try to extract text if present, but warn if there isn't any.
    const hasText =
      candidate.content &&
      Array.isArray(candidate.content.parts) &&
      candidate.content.parts[0] &&
      candidate.content.parts[0].text;
    if (!hasText) {
      return {
        success: false,
        error: `Gemini stopped early (finishReason: ${candidate.finishReason}) and returned no text.`
      };
    }
  }

  const text =
    candidate.content &&
    Array.isArray(candidate.content.parts) &&
    candidate.content.parts[0] &&
    candidate.content.parts[0].text;

  if (!text) {
    return {
      success: false,
      error: `Gemini API response had an unexpected shape. Raw response: ${JSON.stringify(data)}`
    };
  }

  let parsed;
  try {
    parsed = parseModelJson(text);
  } catch (jsonErr) {
    return {
      success: false,
      error: `Could not parse Gemini's output as JSON. Raw text: ${text}`
    };
  }

  if (!parsed || typeof parsed.Title !== "string" || typeof parsed.Keywords !== "string") {
    return {
      success: false,
      error: `Gemini's JSON was missing "Title" or "Keywords". Raw text: ${text}`
    };
  }

  return {
    success: true,
    title: parsed.Title.trim(),
    keywords: parsed.Keywords.trim()
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "GENERATE_METADATA") {
    generateMetadata(message.base64Image, message.mimeType)
      .then((result) => sendResponse(result))
      .catch((err) => {
        // Final safety net — should be unreachable given the handling above.
        sendResponse({ success: false, error: `Unexpected error: ${err.message}` });
      });
    return true; // keep the message channel open for the async response
  }
  return false;
});
