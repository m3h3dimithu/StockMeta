/* ===================== PROVIDERS ===================== */
/*
  Each provider can:
   - listModels(key): returns a ranked array of model id strings this key can use
   - generate(key, model, prompt, base64, mimeType): returns raw text from the model
  Model lists are discovered LIVE from each provider's API every time (cached briefly
  in memory), so we never hardcode a model name that might get retired. If a model
  errors out, the next one is tried automatically, then the next provider.
*/

function rankModels(names){
  function score(n){
    let s = 0;
    if(/flash|mini|lite/i.test(n)) s += 100;   // fast + cheap/free tiers first
    if(/pro\b/i.test(n)) s += 40;
    if(/preview|exp|beta/i.test(n)) s -= 15;
    if(/embedding|tts|image-gen|imagen|veo|lyria|live|aqa|nano-banana|whisper|dall-e|moderation/i.test(n)) s -= 1000;
    const nums = (n.match(/\d+(\.\d+)?/g) || []).map(Number);
    const verScore = nums.reduce((a, b, i) => a + b / Math.pow(10, i), 0);
    return s * 1000 + verScore;
  }
  return [...new Set(names)]
    .filter(n => score(n) > -500)
    .sort((a, b) => score(b) - score(a));
}

function parseJsonLoose(text){
  let cleaned = (text || "").trim();
  cleaned = cleaned.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : cleaned);
}

const PROVIDERS = [
  {
    id: "gemini",
    label: "Google Gemini",
    tag: "free",
    helpUrl: "https://aistudio.google.com/app/apikey",
    placeholder: "AIza...",

    async listModels(key){
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      if(!res.ok) throw new Error(`model list failed (${res.status})`);
      const data = await res.json();
      const names = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => m.name.replace(/^models\//, ""));
      return rankModels(names);
    },

    async generate(key, model, prompt, base64, mimeType){
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64 } }
            ]}],
            generationConfig: { responseMimeType: "application/json", temperature: 0.6 }
          })
        }
      );
      if(!res.ok) throw new Error(`Gemini/${model}: ${res.status} ${(await res.text()).slice(0,140)}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if(!text) throw new Error(`Gemini/${model}: খালি রেসপন্স`);
      return text;
    }
  },

  {
    id: "openrouter",
    label: "OpenRouter",
    tag: "free",
    helpUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-v1-...",

    async listModels(key){
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: key ? { Authorization: `Bearer ${key}` } : {}
      });
      if(!res.ok) throw new Error(`model list failed (${res.status})`);
      const data = await res.json();
      const ids = (data.data || [])
        .filter(m => {
          const mods = m.architecture?.input_modalities || [];
          const supportsImage = mods.includes("image") || /vision|vl(\b|-)/i.test(m.id);
          const promptPrice = parseFloat(m.pricing?.prompt ?? "1");
          const imagePrice = parseFloat(m.pricing?.image ?? "1");
          const isFree = /:free$/.test(m.id) || (promptPrice === 0 && imagePrice === 0);
          return supportsImage && isFree;
        })
        .map(m => m.id);
      return rankModels(ids);
    },

    async generate(key, model, prompt, base64, mimeType){
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }
            ]
          }],
          temperature: 0.6
        })
      });
      if(!res.ok) throw new Error(`OpenRouter/${model}: ${res.status} ${(await res.text()).slice(0,140)}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if(!text) throw new Error(`OpenRouter/${model}: খালি রেসপন্স`);
      return text;
    }
  },

  {
    id: "openai",
    label: "OpenAI",
    tag: "paid",
    helpUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-...",

    async listModels(key){
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` }
      });
      if(!res.ok) throw new Error(`model list failed (${res.status})`);
      const data = await res.json();
      const ids = new Set((data.data || []).map(m => m.id));
      // Only vision-capable chat models make sense here; try newest-sounding first.
      const priority = ["gpt-5-mini", "gpt-5", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"];
      const found = priority.filter(p => ids.has(p));
      return found.length ? found : rankModels([...ids].filter(id => /gpt-(4|5)/i.test(id)));
    },

    async generate(key, model, prompt, base64, mimeType){
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }
            ]
          }],
          response_format: { type: "json_object" },
          temperature: 0.6
        })
      });
      if(!res.ok) throw new Error(`OpenAI/${model}: ${res.status} ${(await res.text()).slice(0,140)}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if(!text) throw new Error(`OpenAI/${model}: খালি রেসপন্স`);
      return text;
    }
  }
];

// Platform presets (approximate — always sanity-check against each platform's
// current contributor guidelines before a real bulk upload)
const PLATFORMS = {
  general:      { label: "General",      icon: "◇", title:[5,12],  kw:[15,30], desc:[20,50]  },
  adobestock:   { label: "Adobe Stock",  icon: "🅰", title:[5,13],  kw:[20,49], desc:[15,40]  },
  shutterstock: { label: "Shutterstock", icon: "▣", title:[6,14],  kw:[25,50], desc:[15,40]  },
  vecteezy:     { label: "Vecteezy",     icon: "◆", title:[5,10],  kw:[15,20], desc:[15,35]  },
  depositphotos:{ label: "Depositphotos",icon: "◈", title:[5,12],  kw:[20,50], desc:[15,40]  },
  "123rf":      { label: "123RF",        icon: "◎", title:[5,12],  kw:[20,50], desc:[15,40]  },
  dreamstime:   { label: "Dreamstime",   icon: "●", title:[5,12],  kw:[20,50], desc:[15,40]  },
  freepik:      { label: "Freepik",      icon: "⚡", title:[5,10],  kw:[15,20], desc:[15,35]  },
  istock:       { label: "iStock",       icon: "▦", title:[4,10],  kw:[20,50], desc:[15,35]  },
};

/* ===================== STATE ===================== */

const apiKeys = JSON.parse(localStorage.getItem("smstudio_keys") || "{}"); // {gemini:'', openrouter:'', openai:''}
const modelCache = {}; // providerId -> { models: [...], fetchedAt }
let currentPlatform = "general";
let images = [];
let idCounter = 0;

function saveKeys(){ localStorage.setItem("smstudio_keys", JSON.stringify(apiKeys)); }

/* ===================== DOM ===================== */

const el = (id) => document.getElementById(id);
const providerList = el("providerList");

const platformTabsEl = el("platformTabs");
const dropzone = el("dropzone");
const fileInput = el("fileInput");
const browseBtn = el("browseBtn");

const queueInfo = el("queueInfo");
const clearBtn = el("clearBtn");
const exportBtn = el("exportBtn");
const generateBtn = el("generateBtn");

const emptyState = el("emptyState");
const grid = el("grid");

const titleMin = el("titleMin"), titleMax = el("titleMax"), titleReadout = el("titleReadout");
const kwMin = el("kwMin"), kwMax = el("kwMax"), kwReadout = el("kwReadout");
const descMin = el("descMin"), descMax = el("descMax"), descReadout = el("descReadout");
const customPrompt = el("customPrompt");

/* ===================== PROVIDER KEY UI ===================== */

function buildProviderList(){
  providerList.innerHTML = "";
  PROVIDERS.forEach(p => {
    const hasKey = !!apiKeys[p.id];
    const row = document.createElement("div");
    row.className = "provider-row";
    row.innerHTML = `
      <div class="provider-head">
        <span>${p.label}</span>
        <span class="provider-tag ${p.tag}">${p.tag === "free" ? "ফ্রি" : "পেইড"}</span>
        <span class="provider-status ${hasKey ? "ok" : ""}" data-status="${p.id}">${hasKey ? "কানেক্টেড" : "খালি"}</span>
      </div>
      <div class="key-input-row" data-row="${p.id}" style="${hasKey ? "display:none;" : ""}">
        <input type="password" data-input="${p.id}" placeholder="${p.placeholder}">
        <button class="btn-small" data-save="${p.id}">সেভ</button>
      </div>
      <a class="key-help" href="${p.helpUrl}" target="_blank" rel="noopener">${p.tag === "free" ? "ফ্রি key নাও →" : "key নাও →"}</a>
    `;
    providerList.appendChild(row);
  });

  providerList.querySelectorAll("[data-status]").forEach(statusEl => {
    statusEl.addEventListener("click", () => {
      const id = statusEl.dataset.status;
      const row = providerList.querySelector(`[data-row="${id}"]`);
      row.style.display = row.style.display === "none" ? "flex" : "none";
    });
  });

  providerList.querySelectorAll("[data-save]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.save;
      const input = providerList.querySelector(`[data-input="${id}"]`);
      const v = input.value.trim();
      if(!v) return;
      apiKeys[id] = v;
      saveKeys();
      delete modelCache[id];
      input.value = "";
      buildProviderList();
    });
  });
}

/* ===================== PLATFORM TABS ===================== */

function buildPlatformTabs(){
  platformTabsEl.innerHTML = "";
  Object.entries(PLATFORMS).forEach(([key, p]) => {
    const btn = document.createElement("button");
    btn.className = "platform-tab" + (key === currentPlatform ? " active" : "");
    btn.innerHTML = `<span>${p.icon}</span><span>${p.label}</span>`;
    btn.addEventListener("click", () => {
      currentPlatform = key;
      applyPlatformPreset(key);
      buildPlatformTabs();
    });
    platformTabsEl.appendChild(btn);
  });
}

function applyPlatformPreset(key){
  const p = PLATFORMS[key];
  titleMin.value = p.title[0]; titleMax.value = p.title[1];
  kwMin.value = p.kw[0];       kwMax.value = p.kw[1];
  descMin.value = p.desc[0];   descMax.value = p.desc[1];
  syncReadouts();
}

/* ===================== SLIDERS ===================== */

function clampPair(minInput, maxInput){
  let mn = parseInt(minInput.value, 10);
  let mx = parseInt(maxInput.value, 10);
  if(mn > mx){ [mn, mx] = [mx, mn]; }
  minInput.value = mn;
  maxInput.value = mx;
  return [mn, mx];
}

function syncReadouts(){
  const [t0,t1] = clampPair(titleMin, titleMax);
  const [k0,k1] = clampPair(kwMin, kwMax);
  const [d0,d1] = clampPair(descMin, descMax);
  titleReadout.textContent = `${t0} – ${t1}`;
  kwReadout.textContent = `${k0} – ${k1}`;
  descReadout.textContent = `${d0} – ${d1}`;
}

[titleMin, titleMax, kwMin, kwMax, descMin, descMax].forEach(inp => {
  inp.addEventListener("input", syncReadouts);
});

/* ===================== FILE HANDLING ===================== */

browseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

["dragenter","dragover"].forEach(ev => dropzone.addEventListener(ev, (e) => {
  e.preventDefault(); dropzone.classList.add("drag");
}));
["dragleave","drop"].forEach(ev => dropzone.addEventListener(ev, (e) => {
  e.preventDefault(); dropzone.classList.remove("drag");
}));
dropzone.addEventListener("drop", (e) => {
  if(e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
});

function handleFiles(fileList){
  const files = Array.from(fileList).filter(f => /^image\/(png|jpeg|jpg|webp)$/.test(f.type));
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const base64 = dataUrl.split(",")[1];
      images.push({
        id: ++idCounter,
        file, name: file.name,
        dataUrl, base64, mimeType: file.type,
        status: "pending",
        title: "", keywords: "", description: "",
        error: "", usedProvider: ""
      });
      renderGrid();
    };
    reader.readAsDataURL(file);
  });
  fileInput.value = "";
}

/* ===================== RENDER ===================== */

function statusLabel(s){
  return { pending: "অপেক্ষমাণ", working: "তৈরি হচ্ছে…", done: "সম্পন্ন", error: "সমস্যা" }[s] || s;
}

function renderGrid(){
  emptyState.style.display = images.length ? "none" : "block";
  grid.innerHTML = "";

  images.forEach(img => {
    const card = document.createElement("div");
    card.className = "item-card";

    card.innerHTML = `
      <img class="item-thumb" src="${img.dataUrl}" alt="">
      <div class="item-body">
        <div class="item-filename">${img.name}</div>
        <div class="item-field">
          <label>Title</label>
          <input type="text" data-field="title" value="${escapeAttr(img.title)}" placeholder="—">
        </div>
        <div class="item-field">
          <label>Keywords</label>
          <textarea data-field="keywords" rows="2" placeholder="—">${img.keywords}</textarea>
        </div>
        <div class="item-field">
          <label>Description</label>
          <textarea data-field="description" rows="2" placeholder="—">${img.description}</textarea>
        </div>
        ${img.error ? `<div style="color:var(--danger);font-size:12px;">${img.error}</div>` : ""}
      </div>
      <div class="item-status">
        <button class="item-remove" title="মুছে ফেলো">✕</button>
        <span class="status-pill ${img.status}">${statusLabel(img.status)}</span>
        ${img.usedProvider ? `<span class="used-provider">${img.usedProvider}</span>` : ""}
        ${img.status === "error" ? `<button class="btn-small" data-retry="1">আবার চেষ্টা</button>` : ""}
      </div>
    `;

    card.querySelector(".item-remove").addEventListener("click", () => {
      images = images.filter(i => i.id !== img.id);
      renderGrid();
    });

    const retryBtn = card.querySelector("[data-retry]");
    if(retryBtn){
      retryBtn.addEventListener("click", () => generateOne(img).then(renderGrid));
    }

    card.querySelectorAll("[data-field]").forEach(inputEl => {
      inputEl.addEventListener("input", () => {
        img[inputEl.dataset.field] = inputEl.value;
      });
    });

    grid.appendChild(card);
  });

  updateActionRow();
}

function escapeAttr(s){
  return (s || "").replace(/"/g, "&quot;");
}

function updateActionRow(){
  const total = images.length;
  const done = images.filter(i => i.status === "done").length;
  queueInfo.textContent = total === 0
    ? "কোনো ছবি যোগ করা হয়নি"
    : `${total} টি ছবি — ${done} টি সম্পন্ন`;
  generateBtn.disabled = total === 0;
  exportBtn.disabled = done === 0;
  clearBtn.disabled = total === 0;
}

/* ===================== PROMPT ===================== */

function buildPrompt(){
  const [t0,t1] = [parseInt(titleMin.value), parseInt(titleMax.value)];
  const [k0,k1] = [parseInt(kwMin.value), parseInt(kwMax.value)];
  const [d0,d1] = [parseInt(descMin.value), parseInt(descMax.value)];
  const platformLabel = PLATFORMS[currentPlatform].label;
  const custom = customPrompt.value.trim();

  return `You are a metadata writer for microstock platforms (target platform: ${platformLabel}).
Look carefully at the attached image and write commercially useful, accurate, SEO-friendly stock metadata for it.

Rules:
- Title: ${t0} to ${t1} words. No camera brand names, no filenames, no keyword-stuffing, plain descriptive sentence-style title, no ending punctuation.
- Keywords: ${k0} to ${k1} single words or short phrases, most relevant first, comma separated, no duplicates, no hashtags.
- Description: ${d0} to ${d1} words, natural sentence(s) describing the subject, setting, mood and potential use case. No marketing fluff, no first person.
${custom ? `- Extra instruction from the user: ${custom}` : ""}

Respond with ONLY a JSON object, no markdown fences, in exactly this shape:
{"title": "...", "keywords": ["...", "..."], "description": "..."}`;
}

/* ===================== MODEL DISCOVERY + GENERATION ===================== */

const MODEL_CACHE_MS = 10 * 60 * 1000; // refresh model list every 10 minutes

async function getCandidateModels(provider){
  const key = apiKeys[provider.id];
  const cached = modelCache[provider.id];
  if(cached && Date.now() - cached.fetchedAt < MODEL_CACHE_MS){
    return cached.models;
  }
  const models = await provider.listModels(key);
  modelCache[provider.id] = { models, fetchedAt: Date.now() };
  return models;
}

async function generateAll(){
  const anyKey = PROVIDERS.some(p => apiKeys[p.id]);
  if(!anyKey){
    const firstRow = providerList.querySelector('[data-row]');
    if(firstRow) firstRow.style.display = "flex";
    const firstInput = providerList.querySelector("input[data-input]");
    if(firstInput) firstInput.focus();
    return;
  }
  const targets = images.filter(i => i.status !== "done");
  for(const img of targets){
    await generateOne(img);
    renderGrid();
  }
}

async function generateOne(img){
  img.status = "working";
  img.error = "";
  img.usedProvider = "";
  renderGrid();

  const prompt = buildPrompt();
  const attemptsLog = [];

  for(const provider of PROVIDERS){
    const key = apiKeys[provider.id];
    if(!key) continue;

    let candidates;
    try{
      candidates = await getCandidateModels(provider);
    } catch(e){
      attemptsLog.push(`${provider.label}: মডেল লিস্ট আনতে ব্যর্থ — ${e.message}`);
      continue;
    }
    if(!candidates.length){
      attemptsLog.push(`${provider.label}: উপযুক্ত কোনো মডেল পাওয়া যায়নি`);
      continue;
    }

    for(const model of candidates.slice(0, 4)){
      try{
        const raw = await provider.generate(key, model, prompt, img.base64, img.mimeType);
        const parsed = parseJsonLoose(raw);
        img.title = (parsed.title || "").toString().trim();
        img.keywords = Array.isArray(parsed.keywords)
          ? parsed.keywords.join(", ")
          : (parsed.keywords || "").toString().trim();
        img.description = (parsed.description || "").toString().trim();
        img.status = "done";
        img.usedProvider = `${provider.label} · ${model}`;
        return;
      } catch(e){
        attemptsLog.push(e.message);
      }
    }
  }

  img.status = "error";
  img.error = attemptsLog.length
    ? "সব চেষ্টা ব্যর্থ: " + attemptsLog.join(" | ")
    : "কোনো কাজ করা API key পাওয়া যায়নি।";
}

/* ===================== CSV EXPORT ===================== */

function csvEscape(s){
  const v = (s || "").toString().replace(/"/g, '""');
  return `"${v}"`;
}

function exportCSV(){
  const rows = [["Filename", "Title", "Keywords", "Description"]];
  images.filter(i => i.status === "done").forEach(i => {
    rows.push([i.name, i.title, i.keywords, i.description]);
  });
  const csvContent = rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stock-metadata-${currentPlatform}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ===================== EVENTS + INIT ===================== */

generateBtn.addEventListener("click", generateAll);
clearBtn.addEventListener("click", () => { images = []; renderGrid(); });
exportBtn.addEventListener("click", exportCSV);

buildProviderList();
buildPlatformTabs();
applyPlatformPreset(currentPlatform);
renderGrid();
