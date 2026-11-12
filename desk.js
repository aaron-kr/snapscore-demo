// SnapScore Desk — browser side. Talks only to the local server (127.0.0.1).
// In the public demo, demo.js stands in for that server (window.deskDemo); locally it is absent.
"use strict";
const DEMO = window.deskDemo;
const url = p => DEMO ? DEMO.src(p) : p;            // images and downloads the server would serve
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = { batch: null, keys: [], layouts: [], sort: "n", dir: 1, lb: -1, poll: null, ver: 0 };
const LS = DEMO?.storage || { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
                             set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.json !== undefined) { o.method = o.method || "POST"; o.body = JSON.stringify(o.json); o.headers = { "Content-Type": "application/json" }; }
  const r = await fetch(path, o);
  const d = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
  if (!r.ok) throw new Error(d?.error || r.statusText);
  return d;
}
function toast(msg, bad = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = "toast", bad ? 5000 : 2200);
}

// ------------------------------------------------------------------ keys
async function loadKeys(select) {
  const d = await api("/api/keys");
  S.keys = d.keys; S.layouts = d.layouts;
  const sel = $("#keySel");
  sel.innerHTML = `<option value="">— choose a key —</option>` + S.keys.map(k =>
    `<option value="${esc(k.name)}">${esc(k.name)}${k.source === "desk" ? "" : "  (exam)"}</option>`).join("");
  $("#kLayout").innerHTML = S.layouts.map(l => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join("");
  sel.value = select ?? S.batch?.key ?? LS.get("desk.key") ?? "";
  if (!S.keys.some(k => k.name === sel.value)) sel.value = "";
  showKeyInfo();
}
function curKey() { return S.keys.find(k => k.name === $("#keySel").value); }
function showKeyInfo() {
  const k = curKey(), el = $("#keyInfo");
  if (!k) { el.innerHTML = `<span>No key chosen yet.</span>`; return; }
  const lay = S.layouts.find(l => l.id === k.layout)?.label || k.layout;
  el.innerHTML = Object.entries(k.versions).map(([v, n]) => `<span class="chip">Version ${esc(v)} · ${n}</span>`).join("")
    + `<span style="flex-basis:100%">${esc(lay)}${k.points != 1 ? ` · ${k.points} pt each` : ""}</span>`
    + (k.source === "desk" ? `<button class="del" id="delKey">remove key</button>` : "");
  $("#delKey")?.addEventListener("click", async () => {
    if (!confirm(`Remove the key “${k.name}”?`)) return;
    await api("/api/keys/delete", { json: { name: k.name } }); await loadKeys(""); toast("Key removed");
  });
}
$("#keySel").addEventListener("change", async () => {
  showKeyInfo(); LS.set("desk.key", $("#keySel").value);
  if (S.batch && $("#keySel").value && S.batch.items.length) await grade(false);
  else if (S.batch) await api(`/api/batches/${S.batch.id}/settings`, { json: { key: $("#keySel").value || null } });
});

// add-key dialog
const dlg = $("#keyDlg");
$("#addKey").addEventListener("click", () => { $("#keyForm").reset(); $("#kPreview").innerHTML = ""; dlg.showModal(); $("#kName").focus(); });
let prevT;
$("#kText").addEventListener("input", () => { clearTimeout(prevT); prevT = setTimeout(previewKey, 350); });
async function previewKey() {
  const text = $("#kText").value.trim(), el = $("#kPreview");
  if (!text) { el.innerHTML = ""; return; }
  if (/^https?:\/\//.test(text)) { el.innerHTML = `<span class="muted">Link — it will be fetched when you save.</span>`; return; }
  try {
    const d = await api("/api/keys/preview", { json: { text } });
    el.innerHTML = `<span class="ok">✓ Read ${Object.keys(d.versions).length} version(s)</span><br>` +
      Object.entries(d.answers).map(([v, a]) => `<b>${esc(v)}</b> (${d.versions[v]}): <code>${esc(a)}</code>`).join("<br>");
  } catch (e) { el.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
}
["dragenter", "dragover"].forEach(ev => $("#kText").addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); $("#kText").classList.add("over"); }));
["dragleave", "drop"].forEach(ev => $("#kText").addEventListener(ev, () => $("#kText").classList.remove("over")));
$("#kText").addEventListener("drop", async e => {
  e.preventDefault(); e.stopPropagation();
  const f = e.dataTransfer.files[0]; if (!f) return;
  $("#kText").value = await f.text();
  if (!$("#kName").value) $("#kName").value = f.name.replace(/\.[^.]+$/, "");
  previewKey();
});
$("#keyForm").addEventListener("submit", async e => {
  if (e.submitter?.value !== "save") return;
  e.preventDefault();
  try {
    const d = await api("/api/keys", { json: { name: $("#kName").value, text: $("#kText").value, layout: $("#kLayout").value, points: $("#kPoints").value } });
    dlg.close(); await loadKeys(d.name); LS.set("desk.key", d.name); toast(`Key “${d.name}” saved`);
    if (S.batch?.items.length) grade(false);
  } catch (err) { $("#kPreview").innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
});

// ------------------------------------------------------------------ batches
async function loadRecent() {
  const d = await api("/api/batches");
  const sel = $("#recent");
  sel.innerHTML = `<option value="">Recent batches…</option>` + d.batches.map(b =>
    `<option value="${b.id}">${esc(b.title)} · ${b.n} sheet${b.n === 1 ? "" : "s"}</option>`).join("");
  sel.value = "";
}
$("#recent").addEventListener("change", e => e.target.value && openBatch(e.target.value));
$("#newBatch").addEventListener("click", async () => { await newBatch(); toast("New batch"); });
async function newBatch() {
  S.batch = await api("/api/batches", { json: {} });
  LS.set("desk.batch", S.batch.id); render(); loadRecent();
}
async function openBatch(id) {
  try { S.batch = await api(`/api/batches/${id}`); } catch { return newBatch(); }
  LS.set("desk.batch", id);
  if (S.batch.key) { $("#keySel").value = S.batch.key; showKeyInfo(); }
  render(); if (S.batch.state === "grading") startPoll();
}
async function ensureBatch() { if (!S.batch) await newBatch(); return S.batch; }
$("#title").addEventListener("change", async () => {
  if (!S.batch) return;
  S.batch = await api(`/api/batches/${S.batch.id}/settings`, { json: { title: $("#title").value } }); loadRecent(); setLinks();
});

// ------------------------------------------------------------------ adding files
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => { if (!dlg.open) { e.preventDefault(); drop.classList.add("over"); } }));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => { if (ev === "drop" || e.target === document.documentElement) drop.classList.remove("over"); }));
document.addEventListener("drop", async e => {
  if (dlg.open) return;
  e.preventDefault(); drop.classList.remove("over");
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = entries.length ? await walk(entries) : [...e.dataTransfer.files].map(f => [f, f.name]);
  upload(files);
});
async function walk(entries, prefix = "") {
  const out = [];
  for (const en of entries) {
    if (en.isFile) out.push([await new Promise(r => en.file(r)), prefix + en.name]);
    else if (en.isDirectory) {
      const rd = en.createReader(); let batch, all = [];
      do { batch = await new Promise(r => rd.readEntries(r)); all = all.concat(batch); } while (batch.length);
      out.push(...await walk(all, prefix + en.name + "/"));
    }
  }
  return out;
}
$("#pickFiles").addEventListener("click", () => $("#files").click());
$("#pickFolder").addEventListener("click", () => $("#folder").click());
$("#files").addEventListener("change", e => { upload([...e.target.files].map(f => [f, f.name])); e.target.value = ""; });
$("#folder").addEventListener("change", e => { upload([...e.target.files].map(f => [f, f.webkitRelativePath || f.name])); e.target.value = ""; });
const OK_EXT = /\.(jpe?g|png|tiff?|bmp|webp|pdf|zip)$/i;
async function upload(list) {
  list = list.filter(([f, n]) => OK_EXT.test(n)).sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
  if (!list.length) return toast("No images, PDFs or zips in that drop", true);
  const b = await ensureBatch();
  let i = 0;
  for (const [f, name] of list) {
    toast(`Adding ${++i} / ${list.length}: ${name}`);
    try { S.batch = await api(`/api/batches/${b.id}/upload?name=${encodeURIComponent(name)}`, { method: "POST", body: f }); }
    catch (e) { toast(`${name}: ${e.message}`, true); }
    render();
  }
  afterAdd();
}
$("#pathForm").addEventListener("submit", async e => {
  e.preventDefault();
  const p = $("#path").value.trim(); if (!p) return;
  const b = await ensureBatch();
  try { toast("Reading the folder…"); S.batch = await api(`/api/batches/${b.id}/path`, { json: { path: p } }); $("#path").value = ""; render(); afterAdd(); }
  catch (err) { toast(err.message, true); }
});
function afterAdd() {
  loadRecent();
  if ($("#keySel").value) grade(true);
  else { toast("Files listed. Choose an answer key to grade them."); $("#keySel").focus(); }
}

// ------------------------------------------------------------------ grading
async function grade(onlyNew) {
  const key = $("#keySel").value;
  if (!key) { toast("Choose an answer key first", true); $("#keySel").focus(); return; }
  if (!S.batch?.items.length) return toast("Add some scans first", true);
  try { S.batch = await api(`/api/batches/${S.batch.id}/grade`, { json: { key, only_new: onlyNew } }); render(); startPoll(); }
  catch (e) { toast(e.message, true); }
}
$("#grade").addEventListener("click", () => grade(false));
function startPoll() {
  clearInterval(S.poll);
  S.poll = setInterval(async () => {
    S.batch = await api(`/api/batches/${S.batch.id}`); render();
    if (S.batch.state !== "grading") { clearInterval(S.poll); const c = counts(); toast(`Graded ${c.done} sheet${c.done === 1 ? "" : "s"}` + (c.check ? ` · ${c.check} to check` : "")); }
  }, 700);
}

// ------------------------------------------------------------------ curve + roster
$("#curveOn").addEventListener("change", async () => {
  $("#curveBox").hidden = !$("#curveOn").checked;
  let a = null;
  if ($("#curveOn").checked) { a = Number($("#curveA").value) || suggestA() || 50; $("#curveA").value = a; }
  await saveSettings({ curve_a: a });
});
$("#curveA").addEventListener("change", () => saveSettings({ curve_a: Number($("#curveA").value) }));
let rosterT;
$("#roster").addEventListener("input", () => { clearTimeout(rosterT); rosterT = setTimeout(() => saveSettings({ roster: $("#roster").value }), 500); });
async function saveSettings(d) { if (!S.batch) await ensureBatch(); S.batch = await api(`/api/batches/${S.batch.id}/settings`, { json: d }); render(); }
function suggestA() {
  const p = done().map(i => i.percent).sort((a, b) => a - b);
  if (p.length < 3) return null;
  const pos = 0.3 * (p.length - 1), lo = Math.floor(pos), P30 = p[lo] + (pos - lo) * ((p[lo + 1] ?? p[lo]) - p[lo]);
  return Math.round((80 - P30 / 2) * 10) / 10;
}
const curve = pct => (S.batch?.curve_a == null || pct == null) ? null : Math.round(Math.min(100, Math.max(60, S.batch.curve_a + 0.5 * pct)) * 10) / 10;
function rosterMap() {
  const m = {};
  for (const line of (S.batch?.roster || "").split(/\r?\n/)) {
    const id = line.match(/\b\d{6,}\b/); if (!id) continue;
    const rest = line.replace(id[0], " ").trim().split(/[\t,;]+|\s{2,}/).map(s => s.trim()).filter(Boolean);
    const no = rest.find(s => /^\d{1,4}$/.test(s)) || "";
    m[id[0]] = { no, name: rest.filter(s => s !== no).join(" ") };
  }
  return m;
}

// ------------------------------------------------------------------ list
const done = () => (S.batch?.items || []).filter(i => i.status === "done");
function counts() {
  const it = S.batch?.items || [];
  return { n: it.length, done: done().length, check: done().filter(needsCheck).length,
           err: it.filter(i => i.status === "error").length, busy: it.filter(i => ["queued", "reading"].includes(i.status)).length };
}
const needsCheck = i => (i.unclear?.length || 0) > 0 || !!i.version_note;
function sorted() {
  const r = rosterMap(), it = [...(S.batch?.items || [])];
  const val = i => ({ n: i.n, name: i.name, sid: r[i.sid]?.no ? r[i.sid].no.padStart(4, "0") : (i.sid || "~"),
                      correct: i.correct ?? -1, percent: i.percent ?? -1, curved: curve(i.percent) ?? -1 }[S.sort]);
  return it.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : a.n - b.n) * S.dir; });
}
document.querySelectorAll(".lhead button").forEach(b => b.addEventListener("click", () => {
  const k = b.dataset.sort; S.dir = S.sort === k ? -S.dir : (["correct", "percent", "curved"].includes(k) ? -1 : 1); S.sort = k; render();
}));

function render() {
  const b = S.batch, has = !!b?.items.length;
  $("#title").value = b?.title || "";
  $("#drop").classList.toggle("compact", has);
  ["#bar", "#listWrap"].forEach(s => $(s).hidden = !has);
  $("#empty").hidden = has;
  $("#curveOn").checked = b?.curve_a != null; $("#curveBox").hidden = b?.curve_a == null;
  if (b?.curve_a != null && document.activeElement !== $("#curveA")) $("#curveA").value = b.curve_a;
  if (document.activeElement !== $("#roster")) $("#roster").value = b?.roster || "";
  const sa = suggestA();
  $("#curveHint").innerHTML = sa == null ? "Rule: the 30th-percentile student ends at 80. Grade some sheets to get a suggestion." :
    `Suggested a = <b>${sa}</b> (30th percentile → 80)` + (sa < 50 ? `. Below 50 a perfect paper cannot reach 100, so use at least 50.` : "") +
    ` <button class="linkbtn" id="useA">use ${Math.max(50, sa)}</button>`;
  $("#useA")?.addEventListener("click", () => { $("#curveA").value = Math.max(50, sa); saveSettings({ curve_a: Math.max(50, sa) }); });
  if (!has) return;
  const c = counts();
  $("#counts").innerHTML = `<span><b>${c.n}</b> sheet${c.n === 1 ? "" : "s"}</span><span><b>${c.done}</b> graded</span>` +
    (c.busy ? `<span><span class="spin"></span> <b>${c.busy}</b> to go</span>` : "") +
    (c.check ? `<span class="warn"><b>${c.check}</b> to check</span>` : "") + (c.err ? `<span class="bad"><b>${c.err}</b> not read</span>` : "");
  $("#grade").textContent = c.done ? "Grade again" : "Grade";
  $("#grade").disabled = b.state === "grading";
  setLinks(); renderStats();
  document.querySelectorAll(".lhead button").forEach(x => x.classList.toggle("on", x.dataset.sort === S.sort));
  const r = rosterMap(), v = ++S.ver;
  $("#list").innerHTML = sorted().map(i => rowHtml(i, r)).join("");
  if (S.lb >= 0) showLb(S.lb, true);
}
function rowHtml(i, r) {
  const ro = r[i.sid] || {}, cur = curve(i.percent), stamp = (i.correct ?? "") + "-" + (i.version ?? "");
  let flags = "", right = "";
  if (i.status === "done") {
    flags = `<span class="chip ver">${esc(i.version)}</span>` + (i.unclear?.length ? `<span class="chip warn">check ${i.unclear.map(q => "Q" + q).join(", ")}</span>` : "") +
      (i.version_note ? `<span class="chip warn">version?</span>` : "") + (Object.keys(i.fixed || {}).length ? `<span class="chip">edited</span>` : "");
    right = `<span class="c-score">${i.correct}<span class="muted">/${i.total}</span></span><span class="c-pct">${i.percent}</span><span class="c-cur">${cur ?? ""}</span>`;
  } else {
    const st = { new: "waiting for a key", queued: "queued", reading: `<span class="spin"></span> reading`, error: "" }[i.status] ?? i.status;
    if (i.status === "error") flags = `<span class="chip bad" title="${esc(i.error)}">not read</span>`;
    right = `<span class="c-score state">${st}</span><span></span><span></span>`;
  }
  const strip = i.status === "done" ? `<img src="${url(`/api/batches/${S.batch.id}/strips/${i.n}.jpg?v=${stamp}`)}" alt="" loading="lazy">` : "";
  return `<div class="row" role="listitem" tabindex="0" data-n="${i.n}">
    <span class="c-n">${ro.no || i.n}</span><span class="c-strip">${strip}</span>
    <span class="c-file"><div class="fname" title="${esc(i.name)}">${esc(i.name)}</div><div class="flags">${flags}</div></span>
    <span class="c-id">${esc(i.sid || "")}<small>${esc(i.sname || ro.name || "")}</small></span>${right}</div>`;
}
$("#list").addEventListener("click", e => { const row = e.target.closest(".row"); if (row) openLb(+row.dataset.n); });
$("#list").addEventListener("keydown", e => { if (e.key === "Enter") { const row = e.target.closest(".row"); if (row) openLb(+row.dataset.n); } });

function setLinks() {
  if (!S.batch) return;
  $("#csv").href = url(`/api/batches/${S.batch.id}/export.csv`);
  $("#zip").href = url(`/api/batches/${S.batch.id}/marked.zip`);
}
function renderStats() {
  const p = done().map(i => i.percent);
  const el = $("#stats");
  if (!p.length) { el.hidden = true; return; }
  el.hidden = false;
  const s = [...p].sort((a, b) => a - b), mean = p.reduce((a, b) => a + b, 0) / p.length;
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const bins = Array(10).fill(0); p.forEach(x => bins[Math.min(9, Math.floor(x / 10))]++);
  const mx = Math.max(...bins), W = 300, H = 52;
  const bars = bins.map((n, k) => `<rect x="${k * 30 + 2}" y="${H - (n / mx) * (H - 4)}" width="26" height="${(n / mx) * (H - 4)}" rx="2"><title>${k * 10}–${k * 10 + 9}%: ${n}</title></rect>` +
    `<text x="${k * 30 + 15}" y="${H + 10}" text-anchor="middle">${k * 10}</text>`).join("");
  const cur = done().map(i => curve(i.percent)).filter(x => x != null);
  // Hardest questions: share right per question, over the sheets that have it in their key.
  const per = {};
  for (const i of done()) for (const q of Object.keys(i.answers || {})) {
    const t = per[q] ||= { n: 0, ok: 0 }; t.n++; if (!(i.wrong || []).includes(q)) t.ok++;
  }
  const hard = Object.entries(per).map(([q, t]) => [q, Math.round(100 * t.ok / t.n)]).sort((a, b) => a[1] - b[1]).slice(0, 5);
  el.innerHTML = [["Graded", p.length], ["Mean", mean.toFixed(1) + "%"], ["Median", med.toFixed(1) + "%"], ["Lowest", s[0] + "%"], ["Highest", s[s.length - 1] + "%"]]
    .concat(cur.length ? [["Curved mean", (cur.reduce((a, b) => a + b, 0) / cur.length).toFixed(1)]] : [])
    .map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("") +
    `<div class="hist"><svg viewBox="0 0 ${W} ${H + 12}" preserveAspectRatio="none" role="img" aria-label="Score distribution">${bars}</svg></div>` +
    (p.length >= 3 && hard.length ? `<div class="tile hard"><div class="k" title="Share of students who got each question right (by question number on their own version)">Hardest questions</div><div class="qs">${
      hard.map(([q, v]) => `<span class="chip${v < 50 ? " warn" : ""}">Q${esc(q)} · ${v}%</span>`).join("")}</div></div>` : "");
}

$("#copy").addEventListener("click", async () => {
  const d = await api(`/api/batches/${S.batch.id}/rows`);
  const roster = !!S.batch.roster?.trim();
  const head = (roster ? ["No."] : []).concat(["Student ID", "Name", "Version", "Correct", "Total", "Percent"], S.batch.curve_a != null ? ["Curved"] : []);
  const lines = d.rows.map(r => (roster ? [r.no] : []).concat([r.student_id, r.name, r.version, r.correct, r.total, r.percent], S.batch.curve_a != null ? [r.curved] : []).join("\t"));
  await navigator.clipboard.writeText([head.join("\t"), ...lines].join("\n"));
  toast(`Copied ${d.rows.length} rows — paste into Excel or Google Sheets`);
});
$("#openFolder").addEventListener("click", () => api(`/api/batches/${S.batch.id}/open`, { json: {} }).then(() => toast("Opened the folder of marked sheets")));

// ------------------------------------------------------------------ lightbox
const lb = $("#lb");
let order = [];
function openLb(n) { order = sorted().map(i => i.n); S.lb = n; lb.hidden = false; lb.classList.remove("zoom"); document.body.style.overflow = "hidden"; showLb(n); $("#lbClose").focus(); }
function closeLb() {
  const n = S.lb; S.lb = -1; lb.hidden = true; document.body.style.overflow = "";
  document.querySelector(`.row[data-n="${n}"]`)?.focus({ preventScroll: false });
}
function step(d) {
  const k = order.indexOf(S.lb), j = Math.min(order.length - 1, Math.max(0, k + d));
  if (j !== k) { S.lb = order[j]; lb.classList.remove("zoom"); showLb(S.lb); }
}
function showLb(n, refresh = false) {
  const i = S.batch.items.find(x => x.n === n); if (!i) return closeLb();
  const k = order.indexOf(n), stamp = (i.correct ?? "") + "-" + (i.version ?? "") + "-" + Object.values(i.fixed || {}).join("");
  const src = url(i.status === "done" ? `/api/batches/${S.batch.id}/marked/${n}.jpg?v=${encodeURIComponent(stamp)}` : `/api/batches/${S.batch.id}/original/${n}`);
  if ($("#lbImg").getAttribute("src") !== src) $("#lbImg").src = src;
  $("#lbPrev").disabled = k <= 0; $("#lbNext").disabled = k >= order.length - 1;
  $("#lbPos").textContent = `${k + 1} / ${order.length}`;
  if (refresh && lb.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  const ro = rosterMap()[i.sid] || {}, cur = curve(i.percent), key = curKey();
  let h = `<p class="lb-file">${esc(i.name)}</p>`;
  if (i.status === "done") {
    h += `<div class="big">${i.correct} / ${i.total}<small>${i.percent}%</small></div>` + (cur != null ? `<div class="curvedline">Curved: ${cur}</div>` : "");
    if (i.version_note) h += `<div class="note-box">${esc(i.version_note)}</div>`;
    h += `<div class="lb-sec"><h3>Version</h3><div class="seg">${(i.versions || []).map((v, x) => `<button data-ver="${esc(v)}" class="${v === i.version ? "on" : ""}" title="Press ${x + 1}">${esc(v)}</button>`).join("")}</div></div>`;
  } else if (i.status === "error") {
    h += `<div class="err-box">${esc(i.error)}</div><p class="hint">Showing the original. Retake the photo with all four corner squares in view, flat and evenly lit, then add it again.</p>`;
  } else h += `<p class="hint">Not graded yet${key ? "" : " — choose an answer key"}.</p>`;
  h += `<div class="lb-sec"><h3>Student</h3>
    <div class="field"><span>ID</span><input id="fSid" value="${esc(i.sid || "")}" placeholder="type the student ID" inputmode="numeric"></div>
    <div class="field"><span>Name</span><input id="fName" value="${esc(i.sname || ro.name || "")}" placeholder="optional"></div>
    ${ro.no ? `<div class="hint">Roster No. ${esc(ro.no)}</div>` : ""}
    ${i.status === "done" ? `<img class="lb-strip" src="${url(`/api/batches/${S.batch.id}/strips/${n}.jpg?v=${encodeURIComponent(stamp)}`)}" alt="Name and ID as written">` : ""}</div>`;
  if (i.status === "done") {
    const fixed = i.fixed || {}, todo = [...new Set([...(i.unclear || []), ...Object.keys(fixed)])];
    if (todo.length) {
      h += `<div class="lb-sec"><h3>Check on the sheet</h3><p class="hint" style="margin-top:-4px">Two marks, a faint mark or an erasure. Counted wrong until you pick the answer.</p>` +
        todo.map(q => `<div class="fix"><span class="q">Q${esc(q)}</span>${(i.options || ["A", "B", "C", "D", "E"]).map(o =>
          `<button class="opt ${fixed[q] === o ? "on" : ""}" data-q="${esc(q)}" data-o="${o}">${o}</button>`).join("")}
          ${fixed[q] ? `<button class="linkbtn" data-q="${esc(q)}" data-o="reset">undo</button>` : ""}
          ${i.unclear_notes?.[q] ? `<span class="note">${esc(i.unclear_notes[q])}</span>` : ""}</div>`).join("") + `</div>`;
    }
    const wrong = (i.wrong || []).filter(q => !(i.unclear || []).includes(q));
    h += `<div class="lb-sec"><h3>Wrong (${wrong.length})</h3><div class="wrong">${wrong.length ? wrong.map(q =>
      `<span class="chip" title="answered ${esc(i.answers?.[q] || "nothing")}, key ${esc(i.expected?.[q] || "")}">Q${esc(q)}: ${esc(i.answers?.[q] || "–")} → ${esc(i.expected?.[q] || "")}</span>`).join("") : `<span class="muted">none</span>`}</div></div>`;
    h += `<div class="lb-sec"><h3>Change an answer</h3><div class="fix"><input id="fQ" placeholder="Q" style="width:56px" class="opt" inputmode="numeric">` +
      (i.options || []).map(o => `<button class="opt" data-qfield="1" data-o="${o}">${o}</button>`).join("") + `</div>
      <p class="hint">For a mark the reader got wrong: type the question number, then pick the answer on the paper.</p></div>`;
  }
  h += `<div class="lb-sec lb-actions">
    ${i.status === "done" ? `<a class="btn" href="${url(`/api/batches/${S.batch.id}/marked/${n}.jpg`)}" download="${esc((i.sid ? i.sid + "_" : "") + i.name.replace(/\.[^.]+$/, ""))}-marked.jpg">Download marked</a>` : ""}
    <a class="btn ghost" href="${url(`/api/batches/${S.batch.id}/original/${n}`)}" target="_blank">Original</a>
    <button class="btn ghost" id="fRemove">Remove from list</button></div>`;
  $("#lbBody").innerHTML = h;
}
async function patchItem(n, d) {
  try {
    const it = await api(`/api/batches/${S.batch.id}/items/${n}`, { json: d });
    S.batch.items = S.batch.items.map(x => x.n === n ? it : x); render();
  } catch (e) { toast(e.message, true); }
}
$("#lbBody").addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.ver) patchItem(S.lb, { version: t.dataset.ver });
  else if (t.dataset.qfield) { const q = $("#fQ").value.trim(); if (!q) return $("#fQ").focus(); patchItem(S.lb, { answers: { [q]: t.dataset.o } }); }
  else if (t.dataset.q) patchItem(S.lb, { answers: { [t.dataset.q]: t.dataset.o } });
  else if (t.id === "fRemove") {
    const n = S.lb; step(1); if (S.lb === n) step(-1);
    api(`/api/batches/${S.batch.id}/items/${n}/remove`, { json: {} }).then(b => { S.batch = b; order = order.filter(x => x !== n); if (S.lb === n) closeLb(); render(); });
  }
});
$("#lbBody").addEventListener("change", e => {
  if (e.target.id === "fSid") patchItem(S.lb, { sid: e.target.value });
  if (e.target.id === "fName") patchItem(S.lb, { sname: e.target.value });
});
$("#lbPrev").addEventListener("click", e => { e.stopPropagation(); step(-1); });
$("#lbNext").addEventListener("click", e => { e.stopPropagation(); step(1); });
$("#lbClose").addEventListener("click", closeLb);
$("#lbZoom").addEventListener("click", () => lb.classList.toggle("zoom"));
$("#lbImg").addEventListener("click", e => { e.stopPropagation(); lb.classList.toggle("zoom"); });
$("#lbStage").addEventListener("click", e => { if (e.target === $("#lbStage") || e.target === $("#lbImgWrap")) closeLb(); });
let wheelT = 0;
$("#lbStage").addEventListener("wheel", e => {
  if (lb.classList.contains("zoom")) return;
  e.preventDefault();
  const now = Date.now(); if (now - wheelT < 260 || Math.abs(e.deltaY) < 8) return;
  wheelT = now; step(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
document.addEventListener("keydown", e => {
  if (lb.hidden) return;
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if (e.key === "Escape") { e.preventDefault(); return typing ? document.activeElement.blur() : closeLb(); }
  if (typing) { if (e.key === "Enter") document.activeElement.blur(); return; }
  if (e.key === "Enter" && !document.activeElement?.closest?.("#lbBody button, #lbBody a")) { e.preventDefault(); return closeLb(); }
  if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) { e.preventDefault(); step(1); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) { e.preventDefault(); step(-1); }
  else if (e.key === "Home") { e.preventDefault(); step(-1e6); }
  else if (e.key === "End") { e.preventDefault(); step(1e6); }
  else if (e.key.toLowerCase() === "z") lb.classList.toggle("zoom");
  else if (/^[1-9]$/.test(e.key)) {
    const i = S.batch.items.find(x => x.n === S.lb), v = i?.versions?.[+e.key - 1];
    if (v && v !== i.version) patchItem(S.lb, { version: v });
  }
});

// ------------------------------------------------------------------ start
(async function init() {
  await loadKeys();
  await loadRecent();
  const qs = new URLSearchParams(location.search);
  const last = qs.get("batch") || LS.get("desk.batch");
  if (last) await openBatch(last); else render();
  if (qs.get("open")) openLb(+qs.get("open"));
})();
