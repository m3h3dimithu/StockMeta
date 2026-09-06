/* ===================== CONFIG ===================== */

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Approximate starting points per platform — always double check against
// each platform's current contributor guidelines before bulk uploading.
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

let apiKey = localStorage.getItem("smstudio_api_key") || "";
let currentPlatform = "general";
let images = []; // {id, file, name, dataUrl, base64, mimeType, status, title, keywords, description, error}
let idCounter = 0;

/* ===================== DOM ===================== */

const el = (id) => document.getElementById(id);
const keyStatus = el("keyStatus");
const keyInputRow = el("keyInputRow");
const apiKeyInput = el("apiKeyInput");
const saveKeyBtn = el("saveKeyBtn");

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

/* ===================== API KEY ===================== */

function refreshKeyUI(){
  if(apiKey){
    keyStatus.textContent = "কানেক্টেড";
    keyStatus.classList.add("ok");
    keyInputRow.style.display = "none";
  } else {
    keyStatus.textContent = "সেট করা নেই";
    keyStatus.classList.remove("ok");
    keyInputRow.style.display = "flex";
  }
}
keyStatus.style.cursor = "pointer";
keyStatus.addEventListener("click", () => {
  keyInputRow.style.display = keyInputRow.style.display === "none" ? "flex" : "none";
});

saveKeyBtn.addEventListener("click", () => {
  const v = apiKeyInput.value.trim();
  if(!v) return;
  apiKey = v;
  localStorage.setItem("smstudio_api_key", apiKey);
  apiKeyInput.value = "";
  refreshKeyUI();
});

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
        error: ""
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

/* ===================== GENERATION ===================== */

generateBtn.addEventListener("click", generateAll);
clearBtn.addEventListener("click", () => { images = []; renderGrid(); });
exportBtn.addEventListener("click", exportCSV);

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

async function generateAll(){
  if(!apiKey){
    keyInputRow.style.display = "flex";
    apiKeyInput.focus();
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
  renderGrid();

  try{
    const prompt = buildPrompt();
    const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: img.mimeType, data: img.base64 } }
          ]
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.6 }
      })
    });

    if(!res.ok){
      const errBody = await res.text();
      throw new Error(`API error ${res.status}: ${errBody.slice(0,180)}`);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if(!rawText) throw new Error("খালি রেসপন্স এসেছে, আবার চেষ্টা করো।");

    const parsed = JSON.parse(rawText);
    img.title = (parsed.title || "").trim();
    img.keywords = Array.isArray(parsed.keywords) ? parsed.keywords.join(", ") : (parsed.keywords || "").trim();
    img.description = (parsed.description || "").trim();
    img.status = "done";

  } catch(err){
    console.error(err);
    img.status = "error";
    img.error = err.message || "অজানা সমস্যা হয়েছে।";
  }
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

/* ===================== INIT ===================== */

buildPlatformTabs();
applyPlatformPreset(currentPlatform);
refreshKeyUI();
renderGrid();
