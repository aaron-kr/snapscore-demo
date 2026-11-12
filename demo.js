// SnapScore Desk — public demo. Stands in for the local server (desk/server.py)
// when the Desk page is served as static files (Vercel / GitHub Pages).
//
// The sheets in demo/ were read by the real engine (tools/build_demo.py). This
// file only does what happens after reading, the same way desk/core.py does it:
// choose a version, score against a key (omr.exams._score), take the
// professor's corrections, and draw the marked sheet (tools.mark_graded).
//
// Nothing is sent or stored. All state lives in this tab's memory: a reload
// starts the sample class over, and every visitor has their own copy.
// The local Desk never loads this file (server.py strips the script tag).
(function () {
  "use strict";
  const FEEDBACK_URL = "";     // e.g. a Google Form link; shows a "Give feedback" button when set
  const DATA = "demo/";
  const SNAPSCORE = "a4-70q-5opt-v1";
  const LAYOUTS = [{ id: SNAPSCORE, label: "SnapScore sheet (A4, corner squares)" }];
  const pad = n => String(n).padStart(3, "0");
  const clone = o => JSON.parse(JSON.stringify(o));
  const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

  let D = null, batch = null;
  const keys = new Map(), pages = new Map(), pageImages = new Map(), marked = new Map(), mem = new Map();
  let csvBlob = null;

  // ------------------------------------------------------------- scoring (omr.exams)
  const POS = {};
  ["ABCDE", "12345", "①②③④⑤", "ⓐⓑⓒⓓⓔ"].forEach(s => [...s].forEach((c, i) => POS[c] = i));
  Object.assign(POS, { T: 0, F: 1, O: 0, X: 1 });
  function optionIndex(mark) {
    const m = String(mark ?? "").trim().toUpperCase();
    return m && m !== "?" ? (POS[[...m][0]] ?? null) : null;
  }
  function correct(given, expected) {
    const exp = String(expected ?? "").trim();
    if (exp === "" || exp === "-") return null;
    if (exp === "*") return true;
    const g = optionIndex(given);
    return g !== null && exp.split("|").some(e => optionIndex(e) === g);
  }
  const count = raw => Array.isArray(raw) ? raw.length : typeof raw === "object" ? Object.keys(raw).length
    : [...String(raw)].filter(c => !/\s/.test(c) && c !== ",").length;
  function parseKey(raw, columns) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k), String(v)]));
    const items = (Array.isArray(raw) ? raw : [...String(raw)].filter(c => !/\s/.test(c) && c !== ",")).map(String);
    if (items.length > columns.length) throw fail(`key has ${items.length} answers; the sheet has ${columns.length} questions`);
    return Object.fromEntries(items.map((a, i) => [String(i + 1), a]));
  }
  function score(g, cells, version) {
    const key = g.keys[version];
    let right = 0, total = 0; const wrong = [];
    for (const [q, exp] of Object.entries(key)) {
      if (!g.columns.includes(q)) continue;
      const ok = correct(cells[q] ?? "", exp);
      if (ok === null) continue;
      total++; ok ? right++ : wrong.push(q);
    }
    return { correct: right, total, points: right * g.points, max_points: total * g.points,
             percent: total ? Math.round(1000 * right / total) / 10 : 0, wrong,
             unclear: g.columns.filter(q => cells[q] === "?" && q in key) };
  }
  function grader(k) {
    const n = Math.max(D.questions, ...Object.values(k.versions).map(count));
    if (n > 70) throw fail("the SnapScore sheet has 70 questions");
    const columns = Array.from({ length: n }, (_, i) => String(i + 1)), out = {};
    for (const [v, raw] of Object.entries(k.versions)) { try { out[v.toUpperCase()] = parseKey(raw, columns); } catch { /* skip */ } }
    if (!Object.keys(out).length) throw fail("this key does not fit the answer sheet type");
    return { key: k, columns, keys: out, points: Number(k.points) || 1 };
  }
  function formFromName(name) {
    const head = name.split(/[_.\-\s]/)[0].toUpperCase();
    return head.length <= 2 ? head : "";
  }
  function pickVersion(g, cells, filename) {          // desk.core.Grader.pick_version
    const vs = Object.keys(g.keys);
    if (vs.length === 1) return [vs[0], ""];
    const fits = vs.map(v => [score(g, cells, v).correct, v]).sort((a, b) => b[0] - a[0] || (b[1] > a[1] ? 1 : -1));
    const named = formFromName(filename);
    if (named in g.keys) {
      const best = fits[0];
      if (best[1] !== named && best[0] >= score(g, cells, named).correct + 3)
        return [named, `file name says ${named}, but the answers fit ${best[1]} better (${best[0]})`];
      return [named, ""];
    }
    return [fits[0][1], fits[0][0] >= fits[1][0] + 3 ? "" :
      `version guessed from the answers (${fits[0][1]} ${fits[0][0]} vs ${fits[1][1]} ${fits[1][0]}) - check`];
  }
  function apply(item, g) {                          // desk.core._apply
    const cells = { ...item.read, ...item.fixed };
    const sc = score(g, cells, item.version), key = g.keys[item.version];
    Object.assign(item, { correct: sc.correct, total: sc.total, percent: sc.percent, points: sc.points,
                          max_points: sc.max_points, wrong: sc.wrong, unclear: sc.unclear, options: [..."ABCDE"] });
    item.answers = Object.fromEntries(Object.keys(key).filter(q => g.columns.includes(q)).map(q => [q, cells[q] ?? ""]));
    item.expected = Object.fromEntries(sc.wrong.map(q => [q, key[q]]));
    marked.delete(item.n);
    return cells;
  }

  // ------------------------------------------------------------- keys (desk.core)
  const ANS = /^[A-Ea-e1-5TFOXtfox*\-|?]+$/;
  function answersOf(cells) {
    cells = cells.map(c => String(c).trim().toUpperCase()).filter(Boolean);
    if (cells.length === 1 && cells[0].length > 1 && !cells[0].includes("|")) cells = [...cells[0].replace(/[\s,;]/g, "")];
    for (const c of cells) if (!ANS.test(c)) throw fail(`'${c}' is not an answer (use A-E, 1-5, T/F)`);
    return cells.every(c => c.length === 1) ? cells.join("") : cells;
  }
  function parseKeyText(text) {
    text = String(text || "").trim().replace(/^﻿/, "");
    if (!text) throw fail("the key is empty");
    if (/^https?:\/\//.test(text)) throw fail("Google Sheets links work in SnapScore Desk on a computer. Here, paste the answers instead.");
    const segs = text.split(/[;\n]/).map(s => s.trim()).filter(Boolean);
    const pat = /^(?:version\s*|ver\.?\s*|form\s*)?([A-Za-z0-9]{1,3})\s*[:=]\s*(.+)$/i;
    if (segs.length && segs.every(s => pat.test(s)))
      return Object.fromEntries(segs.map(s => { const m = s.match(pat); return [m[1].toUpperCase(), answersOf(m[2].split(/[\s,\t]+/))]; }));
    const delim = text.includes("\t") ? "\t" : ",";
    const rows = text.split(/\r?\n/).map(r => r.split(delim).map(c => c.trim())).filter(r => r.some(Boolean));
    const head = (rows[0]?.[0] || "").toLowerCase().replace(/\.+$/, "");
    if (["q", "no", "question", "#", "번호", "문항", "num", "number"].includes(head) && rows[0].length >= 2)
      return Object.fromEntries(rows[0].slice(1).map((v, i) => [v.toUpperCase() || `V${i + 1}`, answersOf(rows.slice(1).map(r => r[i + 1] ?? ""))]));
    if (rows.length > 3 && rows.every(r => /^\d{1,3}\.?$/.test(r[0]))) {
      const ncols = Math.max(...rows.map(r => r.length)), out = {};
      for (let i = 1; i < ncols; i++) out["ABCDEFGH"[i - 1]] = answersOf(rows.map(r => r[i] ?? ""));
      return out;
    }
    if (rows.length <= 8 && rows.every(r => r.length >= 2 && /^[A-Za-z0-9]{1,3}$/.test(r[0])))
      return Object.fromEntries(rows.map(r => [r[0].toUpperCase(), answersOf(r.slice(1))]));
    if (rows.length === 1) return { A: answersOf(rows[0]) };
    if (rows.every(r => r.length === 1)) return { A: answersOf(rows.map(r => r[0])) };
    throw fail("could not read the key. Paste e.g. A=ABCDE...;B=EDCBA... or a CSV with one row per version, or columns Q,A,B.");
  }
  const keyInfo = k => ({ name: k.name, source: k.source, layout: k.layout, questions: null, points: k.points, folder: null,
                          versions: Object.fromEntries(Object.entries(k.versions).map(([v, x]) => [v, count(x)])) });
  function getKey(name) { const k = keys.get(name); if (!k) throw fail(`no key named '${name}'`, 404); return k; }

  // ------------------------------------------------------------- batch
  function freshBatch() {
    return { id: "sample-" + Date.now().toString(36), title: D.title + " (sample)", created: Date.now() / 1000,
             key: null, curve_a: null, roster: D.roster, state: "idle", sources: ["sample class"],
             items: D.items.map(i => ({ n: i.n, name: i.name, path: i.name, status: "new", sid: i.sid, sname: i.sname })) };
  }
  const itemOf = n => { const it = batch.items.find(i => i.n === n); if (!it) throw fail(`no sheet ${n}`, 404); return it; };
  const source = n => D.items.find(i => i.n === n);

  function loadPage(n) {
    if (!pages.has(n)) pages.set(n, new Promise(ok => {
      const im = new Image(); im.onload = () => { pageImages.set(n, im); ok(im); }; im.onerror = () => ok(null); im.src = `${DATA}pages/${pad(n)}.jpg`;
    }));
    return pages.get(n);
  }
  function gradeItem(item, g) {                      // desk.core.grade_item, with the reading done in advance
    const s = source(item.n);
    if (s.error) { Object.assign(item, { status: "error", error: s.error }); return; }
    const [version, vnote] = pickVersion(g, s.read, item.name);
    const keep = item.version_set && item.version_set in g.keys ? item.version_set : null;
    Object.assign(item, { status: "done", error: "", read: s.read, fixed: item.fixed || {}, version: keep || version,
                          version_note: keep ? "" : vnote, notes: s.notes, unclear_notes: s.unclear_notes,
                          versions: Object.keys(g.keys).sort() });
    apply(item, g);
  }
  async function startGrading(name, onlyNew) {
    const g = grader(getKey(name));
    batch.key = name; batch.state = "grading";
    const run = batch.id;
    for (const i of batch.items) if (!onlyNew || i.status !== "done") i.status = "queued";
    (async () => {
      for (const it of batch.items.filter(i => i.status === "queued")) {
        if (batch.id !== run) return;
        it.status = "reading";
        await Promise.all([source(it.n).error ? null : loadPage(it.n), new Promise(r => setTimeout(r, 140 + Math.random() * 120))]);
        if (batch.id !== run) return;
        gradeItem(it, g);
      }
      batch.state = "idle";
    })();
  }
  function updateItem(n, d) {                        // desk.core.update_item
    const item = itemOf(n);
    for (const k of ["sid", "sname"]) if (k in d) item[k] = String(d[k]).trim();
    if (d.version) { item.version = item.version_set = d.version.toUpperCase(); item.version_note = ""; }
    if (d.answers) {
      item.fixed = item.fixed || {};
      for (const [q, v] of Object.entries(d.answers)) {
        if (v == null || v === "" || v === "reset") delete item.fixed[q]; else item.fixed[String(q)] = String(v).toUpperCase();
      }
    }
    if (item.status === "done" && batch.key) apply(item, grader(getKey(batch.key)));
    marked.delete(n);
    return item;
  }

  // ------------------------------------------------------------- results (desk.core)
  function parseRoster(text) {
    const out = {};
    for (const line of String(text || "").split(/\r?\n/)) {
      const parts = line.trim().split(/[\t,;]+|\s{2,}|\s(?=\d{6,})/).filter(p => p && p.trim());
      const sid = parts.map(p => p.trim()).find(p => /^\d{6,}$/.test(p));
      if (!sid) continue;
      const rest = parts.map(p => p.trim()).filter(p => p !== sid);
      const no = rest.find(p => /^\d{1,4}$/.test(p)) || "";
      out[sid] = { no, name: rest.filter(p => p !== no).join(" ") };
    }
    return out;
  }
  const curved = (p, a) => p == null || a == null || a === "" ? null : Math.round(Math.min(100, Math.max(60, Number(a) + 0.5 * p)) * 10) / 10;
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  function rows() {
    const roster = parseRoster(batch.roster);
    const out = batch.items.map(i => {
      const sid = (i.sid || "").trim(), r = roster[sid] || {};
      return { no: r.no || "", student_id: sid, name: i.sname || r.name || "", file: i.name, version: i.version || "",
               correct: i.correct ?? "", total: i.total ?? "", percent: i.percent ?? "",
               curved: i.status === "done" ? (curved(i.percent, batch.curve_a) ?? "") : "",
               wrong: (i.wrong || []).join(" "), check: (i.unclear || []).join(" "), status: i.status || "",
               note: i.version_note || i.error || "" };
    });
    if (Object.keys(roster).length) {
      const seen = new Set(out.map(r => r.student_id));
      for (const [sid, r] of Object.entries(roster)) if (!seen.has(sid))
        out.push({ no: r.no, student_id: sid, name: r.name, file: "", version: "", correct: "", total: "", percent: "",
                   curved: "", wrong: "", check: "", status: "no sheet", note: "on the roster, no sheet" });
      out.sort((a, b) => (a.no === "") - (b.no === "") || natural(a.no || a.file, b.no || b.file));
    }
    return out;
  }
  function csvUrl() {
    const r = rows(), head = r.length ? Object.keys(r[0]) : ["file"];
    const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const text = "﻿" + [head.join(","), ...r.map(x => head.map(h => cell(x[h])).join(","))].join("\r\n") + "\r\n";
    if (csvBlob) URL.revokeObjectURL(csvBlob);
    csvBlob = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.getElementById("csv");
    if (a) a.download = batch.title.replace(/[^\w가-힣.-]+/g, "_").replace(/^_+|_+$/g, "") + ".csv";
    return csvBlob;
  }

  // ------------------------------------------------------------- marked sheet (tools.mark_graded.draw_graded)
  const GREEN = "rgb(30,150,30)", RED = "rgb(210,30,30)", ORANGE = "rgb(255,140,0)", BLUE = "rgb(0,60,170)";
  function outcomes(item, g) {
    const cells = { ...item.read, ...item.fixed }, out = [];
    for (const [q, exp] of Object.entries(g.keys[item.version])) {
      if (!g.columns.includes(q)) continue;
      const ok = correct(cells[q] ?? "", exp);
      if (ok === null) continue;
      const raw = String(cells[q] ?? "").trim();
      const kidx = exp.trim() === "*" ? [] : exp.split("|").map(optionIndex).filter(i => i !== null);
      out.push({ label: q, gi: raw && raw !== "?" ? optionIndex(raw) : null, kidx, ok, unclear: raw === "?" });
    }
    return out;
  }
  function markedUrl(n) {
    const item = batch.items.find(i => i.n === n);
    if (!item || item.status !== "done" || !batch.key) return `${DATA}sheets/${pad(n)}.jpg`;
    if (marked.has(n)) return marked.get(n);
    const im = pageImages.get(n);                    // loaded while grading; the photo until then
    if (!im) { loadPage(n); return `${DATA}sheets/${pad(n)}.jpg`; }
    const g = grader(getKey(batch.key)), C = D.centres, size = D.size;
    const W = im.naturalWidth, s = W / 1260, band = Math.round(110 * s);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = im.naturalHeight + band;
    const x = cv.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, W, band); x.drawImage(im, 0, band);
    const r = Math.max(6, Math.floor(size * 0.75)), t = Math.max(2, Math.floor(size / 8));
    const at = (q, k) => C[q]?.[k] && [C[q][k][0], C[q][k][1] + band];
    const circle = (c, rr, col, w) => { x.strokeStyle = col; x.lineWidth = w; x.beginPath(); x.arc(c[0], c[1], rr, 0, 2 * Math.PI); x.stroke(); };
    const line = (a, b, col, w) => { x.strokeStyle = col; x.lineWidth = w; x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke(); };
    const cross = (c, rr, col, w) => { line([c[0] - rr, c[1] - rr], [c[0] + rr, c[1] + rr], col, w); line([c[0] - rr, c[1] + rr], [c[0] + rr, c[1] - rr], col, w); };
    const rect = (x0, y0, x1, y1, col, w) => { x.strokeStyle = col; x.lineWidth = w; x.strokeRect(x0, y0, x1 - x0, y1 - y0); };
    for (const o of outcomes(item, g)) {
      if (!at(o.label, 0)) continue;
      const gp = o.gi !== null ? at(o.label, o.gi) : null;
      if (o.ok) { if (gp) circle(gp, r, GREEN, t + 1); continue; }
      if (gp && !o.unclear) cross(gp, r, RED, t + 1);
      for (const k of o.kidx) { const c = at(o.label, k); if (c) rect(c[0] - r - t, c[1] - r - t, c[0] + r + t, c[1] + r + t, GREEN, t + 1); }
      const c0 = at(o.label, 0), c1 = at(o.label, 1), pitch = c1 ? c1[0] - c0[0] : 2 * r, nx = c0[0] - 1.1 * pitch;
      line([nx - 0.55 * pitch, c0[1] + r], [nx + 0.55 * pitch, c0[1] - r], RED, t + 1);
      if (o.unclear) { const cl = at(o.label, 4); rect(c0[0] - r - t, c0[1] - r - t, cl[0] + r + t, cl[1] + r + t, ORANGE, t); }
    }
    const head = `${g.key.name}  |  Version ${item.version}  |  ${item.correct} / ${item.total}` + (item.sid ? `  |  ${item.sid}` : "");
    x.fillStyle = BLUE; x.font = `600 ${Math.round(26 * s)}px system-ui, sans-serif`; x.fillText(head, 20 * s, 48 * s);
    let lx = 20 * s; const y = 82 * s, rr = 12 * s, tt = Math.max(2, 3 * s);
    x.font = `${Math.round(17 * s)}px system-ui, sans-serif`;
    for (const [shape, col, text] of [["o", GREEN, "your answer, correct"], ["x", RED, "your answer, wrong"], ["sq", GREEN, "correct answer"],
                                      ["/", RED, "question wrong"], ["fr", ORANGE, "unclear mark"]]) {
      const c = [lx + rr, y];
      if (shape === "o") circle(c, rr, col, tt); else if (shape === "x") cross(c, rr, col, tt);
      else if (shape === "sq") rect(c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr, col, tt);
      else if (shape === "/") line([c[0] - rr, c[1] + rr], [c[0] + rr, c[1] - rr], col, tt);
      else rect(c[0] - rr, c[1] - rr / 2, c[0] + rr, c[1] + rr / 2, col, tt);
      x.fillStyle = "#282828"; x.fillText(text, lx + 2 * rr + 8 * s, y + 6 * s);
      lx += 2 * rr + 16 * s + x.measureText(text).width + 26 * s;
    }
    const url = cv.toDataURL("image/jpeg", 0.85);
    marked.set(n, url);
    return url;
  }

  // ------------------------------------------------------------- URLs the page asks for
  function src(p) {
    const m = String(p).match(/\/api\/batches\/[\w-]+\/(strips|marked|original)\/(\d+)/);
    if (m) {
      const n = +m[2];
      if (m[1] === "strips") return `${DATA}strips/${pad(n)}.jpg`;
      if (m[1] === "original") return `${DATA}sheets/${pad(n)}.jpg`;
      return markedUrl(n);
    }
    if (/\/export\.csv$/.test(p)) return batch ? csvUrl() : "#";
    if (/\/marked\.zip$/.test(p)) return "#";
    return p;
  }

  // ------------------------------------------------------------- the API (desk/server.py routes)
  const NO_UPLOAD = "This demo grades the sample class only. To read your own sheets, use SnapScore Desk on a computer.";
  function route(method, p, body) {
    const d = body ? JSON.parse(body) : {};
    let m;
    if (method === "GET") {
      if (p === "/api/keys") return { keys: [...keys.values()].map(keyInfo), layouts: LAYOUTS };
      if (p === "/api/batches") return { batches: [{ id: batch.id, title: batch.title, created: batch.created, key: batch.key,
                                                     n: batch.items.length, graded: batch.items.filter(i => i.status === "done").length }] };
      if ((m = p.match(/^\/api\/batches\/([\w-]+)\/rows$/))) return { rows: rows() };
      if ((m = p.match(/^\/api\/batches\/([\w-]+)$/))) return batch;
    } else {
      if (p === "/api/keys/preview") {
        const v = parseKeyText(d.text);
        return { versions: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, count(x)])),
                 answers: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? x : x.join(" ")])) };
      }
      if (p === "/api/keys") {
        const name = String(d.name || "").replace(/\s+/g, " ").trim();
        if (!name) throw fail("give the key a name");
        const versions = parseKeyText(d.text);
        keys.set(name, { name, source: "desk", layout: d.layout || SNAPSCORE, points: Number(d.points) || 1, versions });
        return keyInfo(keys.get(name));
      }
      if (p === "/api/keys/delete") { if (keys.get(d.name)?.source === "desk") keys.delete(d.name); return { ok: true }; }
      if (p === "/api/batches") { batch = freshBatch(); marked.clear(); return batch; }
      if (/\/(upload|path|open)$/.test(p)) throw fail(NO_UPLOAD);
      if ((m = p.match(/^\/api\/batches\/[\w-]+\/grade$/))) { startGrading(d.key, !!d.only_new); return batch; }
      if ((m = p.match(/^\/api\/batches\/[\w-]+\/settings$/))) {
        for (const k of ["title", "curve_a", "roster", "key"]) if (k in d) batch[k] = d[k];
        marked.clear(); return batch;
      }
      if ((m = p.match(/^\/api\/batches\/[\w-]+\/items\/(\d+)\/remove$/))) { batch.items = batch.items.filter(i => i.n !== +m[1]); return batch; }
      if ((m = p.match(/^\/api\/batches\/[\w-]+\/items\/(\d+)$/))) return updateItem(+m[1], d);
      if ((m = p.match(/^\/api\/batches\/[\w-]+\/delete$/))) { batch = freshBatch(); return { ok: true }; }
    }
    throw fail("not found", 404);
  }

  const ready = fetch(DATA + "class.json").then(r => r.json()).then(d => {
    D = d;
    keys.set(D.key.name, { ...D.key, source: "exams" });
    batch = freshBatch();
    mem.set("desk.batch", batch.id);
  });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!u.pathname.startsWith("/api/") || u.origin !== location.origin) return realFetch(input, opts);
    await ready;
    let out, status = 200;
    try { out = clone(route((opts.method || "GET").toUpperCase(), u.pathname, typeof opts.body === "string" ? opts.body : null)); }
    catch (e) { out = { error: e.message }; status = e.status || 500; }
    return new Response(JSON.stringify(out), { status, headers: { "Content-Type": "application/json" } });
  };

  // Page memory for desk.js (localStorage on the local Desk): this tab only.
  window.deskDemo = { src, storage: { get: k => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) } };

  // ------------------------------------------------------------- what the visitor sees differently
  const $ = s => document.querySelector(s);
  document.body.classList.add("demo");
  $("#newBatch").textContent = "Start over";
  $("#newBatch").title = "Put the sample class back the way it was";
  ["label.recent", "#openFolder", "#zip", "#pathForm", ".drop-actions"].forEach(s => { const e = $(s); if (e) e.style.display = "none"; });
  $(".drop-title").textContent = "Sample class: 17 answer sheets, already scanned";
  $(".drop-sub").textContent = "Reading your own photos needs SnapScore Desk on a computer, or the phone app.";
  const note = $(".keys-help .hint");
  if (note) note.textContent = "Everything runs in this browser tab. Nothing is uploaded or saved; reload to start over.";
  const intro = document.createElement("section");
  intro.className = "demo-intro";
  intro.innerHTML = `<h2>Try it: grade a made-up class</h2>
    <ol>
      <li>Pick the key <b>Demo Quiz 1</b> in step 1. The sheets are graded at once.</li>
      <li>Open each sheet marked <span class="chip warn">check</span> and pick the answer you see on the paper.</li>
      <li>One student forgot the ID: find the name on the roster (step 3) and type the ID in.</li>
      <li>Look at the class results above the list, turn on the curve, then sort or export the scores.</li>
    </ol>
    <p class="hint">Names, IDs and answers are invented. Nothing you do here is saved or sent anywhere.</p>
    ${FEEDBACK_URL ? `<a class="btn primary wide" href="${FEEDBACK_URL}" target="_blank" rel="noopener">Give feedback</a>` : ""}`;
  $(".side").prepend(intro);
})();
