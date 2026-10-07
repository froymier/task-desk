require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.set("trust proxy", 1); // so req.secure works behind Render's TLS proxy
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("\n  Missing MONGODB_URI. Copy .env.example to .env and paste your Atlas connection string.\n");
  process.exit(1);
}

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error("\n  Missing SESSION_SECRET. Add a long random string to your .env (used to sign login sessions).\n");
  process.exit(1);
}

// Optional: the AI assistant. If this isn't set, the app still works — the Assistant tab just reports it needs a key.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ASSISTANT_MODEL = "claude-haiku-4-5-20251001";
function stripFences(s) {
  return String(s || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

const client = new MongoClient(uri);
let tasks; // the MongoDB collection
let templatesCol; // project templates collection
let settingsCol; // app settings (people, classes, header text)
let usersCol; // login accounts

const DEFAULT_PEOPLE = ["Froy","Miguel","Ben","Angel B","Javier","Tono","Alejandra","Lucia","Gil","Paco","Angel G","Marcelo","Franco","Aaron","Jack","Clay"];
const DEFAULT_CLASSES = ["PLC Prog","Computer Prog","HMI / SCADA","Schematics / Panels","BOMs / Parts","Networking","Routing","Testing and Troubleshooting","Manuals","Retrofits","Service","Prototype"];

// Shape a database document into what the frontend expects.
const out = (d) => ({
  id: d._id.toString(),
  title: d.title,
  who: d.who || "",
  cls: Array.isArray(d.cls) ? d.cls : (d.cls ? [d.cls] : []),
  project: d.project || "",
  due: d.due || "",
  notes: d.notes || "",
  done: !!d.done,
  createdAt: d.createdAt,
  completedAt: d.completedAt || null,
});

// Keep only fields we allow clients to set.
function clean(body, { partial } = {}) {
  const allowed = ["title", "who", "cls", "project", "due", "notes", "done"];
  const obj = {};
  for (const k of allowed) {
    if (k in body) {
      if (k === "done") obj[k] = !!body[k];
      else if (k === "cls") obj[k] = Array.isArray(body[k])
        ? body[k].filter(x => typeof x === "string" && x.trim()).map(x => x.trim())
        : (typeof body[k] === "string" && body[k].trim() ? [body[k].trim()] : []);
      else if (typeof body[k] === "string") obj[k] = body[k].trim();
      else obj[k] = body[k];
    }
  }
  if (!partial) {
    obj.title = (obj.title || "").trim();
    obj.who = obj.who || "";
    obj.cls = Array.isArray(obj.cls) ? obj.cls : [];
    obj.project = obj.project || "";
    obj.due = obj.due || "";
    obj.notes = obj.notes || "";
    obj.done = false;
  }
  return obj;
}

// ---- auth ----
// Passwords come from environment variables, never the code. Set them in .env
// (and in your host's env settings). Usernames are the keys (lowercase).
// Users live in the DB (the "users" collection). This cache mirrors it for fast per-request auth checks.
let userCache = {};  // username -> { name }
async function refreshUserCache() {
  const us = await usersCol.find({}, { projection: { salt: 0, hash: 0 } }).toArray();
  userCache = {};
  us.forEach((u) => { userCache[u._id] = { name: u.name, role: u.role === "admin" ? "admin" : "member" }; });
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  if (!salt || !hash || typeof pw !== "string") return false;
  const h = crypto.scryptSync(pw, salt, 32);
  const hb = Buffer.from(hash, "hex");
  return h.length === hb.length && crypto.timingSafeEqual(h, hb);
}
const slugUser = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
const SESSION_DAYS = 30;

const sign = (payload) => crypto.createHmac("sha256", SECRET).update(payload).digest("hex");

function makeToken(username) {
  const payload = `${username}:${Date.now() + SESSION_DAYS * 86400000}`;
  return Buffer.from(payload).toString("base64url") + "." + sign(payload);
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [b64, sig] = token.split(".");
  let payload;
  try { payload = Buffer.from(b64, "base64url").toString("utf8"); } catch { return null; }
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [username, exp] = payload.split(":");
  if (!exp || Date.now() > Number(exp)) return null;
  return username;
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const found = header.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie",
    `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` + (secure ? "; Secure" : ""));
}

function requireAuth(req, res, next) {
  const username = verifyToken(getCookie(req, "session"));
  if (!username || !userCache[username]) return res.status(401).json({ error: "Not signed in" });
  req.username = username;
  req.role = userCache[username].role;
  next();
}
function requireAdmin(req, res, next) {
  if (req.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

app.post("/api/login", async (req, res) => {
  const username = slugUser(req.body && req.body.username);
  const password = (req.body && req.body.password) || "";
  try {
    const user = await usersCol.findOne({ _id: username });
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      return res.status(401).json({ error: "Wrong user or password" });
    }
    setSessionCookie(req, res, makeToken(username));
    res.json({ name: user.name, role: user.role === "admin" ? "admin" : "member" });
  } catch (e) { res.status(500).json({ error: "Login failed" }); }
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ name: userCache[req.username].name, role: req.role });
});

// Any signed-in user can change THEIR OWN password (must supply the current one).
app.post("/api/me/password", requireAuth, async (req, res) => {
  try {
    const current = String((req.body && req.body.currentPassword) || "");
    const next = String((req.body && req.body.newPassword) || "");
    if (next.length < 4) return res.status(400).json({ error: "New password must be at least 4 characters" });
    const u = await usersCol.findOne({ _id: req.username });
    if (!u || !verifyPassword(current, u.salt, u.hash)) return res.status(401).json({ error: "Current password is incorrect" });
    const { salt, hash } = hashPassword(next);
    await usersCol.updateOne({ _id: req.username }, { $set: { salt, hash } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not change password" }); }
});

// ---- users (login accounts) ----
// Public: usernames + display names + role, so the login screen can list them.
app.get("/api/users", (req, res) => {
  res.json(Object.entries(userCache).map(([username, v]) => ({ username, name: v.name, role: v.role })).sort((a, b) => a.name.localeCompare(b.name)));
});
// Everything that manages OTHER accounts is admin-only.
app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const username = slugUser(req.body && req.body.username);
    const name = String((req.body && req.body.name) || "").trim() || username;
    const password = String((req.body && req.body.password) || "");
    if (!username) return res.status(400).json({ error: "Username required (letters, numbers, . _ -)" });
    if (username === "admin") return res.status(409).json({ error: "That username is reserved" });
    if (password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });
    if (await usersCol.findOne({ _id: username })) return res.status(409).json({ error: "That username already exists" });
    const { salt, hash } = hashPassword(password);
    await usersCol.insertOne({ _id: username, name, role: "member", salt, hash });
    await refreshUserCache();
    res.json({ username, name });
  } catch (e) { res.status(500).json({ error: "Could not add user" }); }
});
app.put("/api/users/:username", requireAuth, requireAdmin, async (req, res) => {
  try {
    const username = slugUser(req.params.username);
    const u = await usersCol.findOne({ _id: username });
    if (!u) return res.status(404).json({ error: "No such user" });
    const set = {};
    if (req.body && typeof req.body.name === "string" && req.body.name.trim() && username !== "admin") set.name = req.body.name.trim();
    if (req.body && req.body.password) {
      if (String(req.body.password).length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });
      const { salt, hash } = hashPassword(String(req.body.password)); set.salt = salt; set.hash = hash;
    }
    // Promote/demote. The built-in "admin" account always stays admin.
    if (req.body && typeof req.body.role === "string" && username !== "admin") {
      set.role = req.body.role === "admin" ? "admin" : "member";
    }
    if (Object.keys(set).length) await usersCol.updateOne({ _id: username }, { $set: set });
    await refreshUserCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not update user" }); }
});
app.delete("/api/users/:username", requireAuth, requireAdmin, async (req, res) => {
  try {
    const username = slugUser(req.params.username);
    if (username === "admin") return res.status(400).json({ error: "The Admin account can't be removed" });
    if ((await usersCol.countDocuments()) <= 1) return res.status(400).json({ error: "Can't remove the last user" });
    await usersCol.deleteOne({ _id: username });
    await refreshUserCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not remove user" }); }
});

// ---- project templates (stored in MongoDB; the Sales Order one is seeded on first run) ----
const DEFAULT_TEMPLATES = [
  {
    name: "Sales Order",
    phases: [
      { name: "Design Schematics",        durationDays: 5, cls: ["Schematics / Panels"],        pool: ["Ben","Tono","Alejandra","Javier","Angel B"] },
      { name: "Review Schematics",        durationDays: 1, cls: ["Schematics / Panels"],        pool: ["Miguel"] },
      { name: "PLC Programming",          durationDays: 5, cls: ["PLC Prog"],                   pool: ["Froy","Franco","Gil","Paco","Marcelo","Angel G"] },
      { name: "HMI Programming",          durationDays: 5, cls: ["HMI / SCADA"],                pool: ["Marcelo","Angel G","Franco"] },
      { name: "Testing & Commissioning",  durationDays: 5, cls: ["Testing and Troubleshooting"],pool: ["Angel G","Marcelo","Franco","Tono"] },
      { name: "Serial Plates Manufacture",durationDays: 2, cls: ["BOMs / Parts"],               pool: ["Alejandra"] },
    ],
  },
];

const templateOut = (d) => ({
  id: d._id.toString(),
  name: d.name,
  phases: (d.phases || []).map((p) => ({ name: p.name, durationDays: p.durationDays, cls: p.cls || [], pool: p.pool || [] })),
});

function cleanTemplate(body) {
  const name = String((body && body.name) || "").trim();
  const phasesIn = Array.isArray(body && body.phases) ? body.phases : [];
  const phases = phasesIn.map((p) => ({
    name: String((p && p.name) || "").trim(),
    durationDays: Math.max(1, parseInt(p && p.durationDays, 10) || 1),
    cls: Array.isArray(p && p.cls) ? p.cls.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [],
    pool: Array.isArray(p && p.pool) ? p.pool.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [],
  })).filter((p) => p.name);
  return { name, phases };
}

// business-day scheduling (skips Sat/Sun), all in UTC to avoid timezone drift
const parseYMD = (s) => new Date(s + "T00:00:00Z");
const fmtYMD = (d) => d.toISOString().slice(0, 10);
const isWknd = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
function ensureBiz(d) { const x = new Date(d); while (isWknd(x)) x.setUTCDate(x.getUTCDate()+1); return x; }
function addBiz(d, n) { const x = new Date(d); let a = 0; while (a < n) { x.setUTCDate(x.getUTCDate()+1); if (!isWknd(x)) a++; } return x; }
function nextBiz(d) { const x = new Date(d); do { x.setUTCDate(x.getUTCDate()+1); } while (isWknd(x)); return x; }
function scheduleDues(startYMD, phases) {
  let cursor = ensureBiz(parseYMD(startYMD));
  return phases.map((p) => {
    const end = addBiz(cursor, Math.max(1, p.durationDays) - 1);
    cursor = nextBiz(end);
    return fmtYMD(end);
  });
}

// ---- routes ----
// Lightweight, public health check — used by uptime pingers to keep the service warm.
app.get("/healthz", (req, res) => res.type("text").send("ok"));

app.get("/api/tasks", requireAuth, async (req, res) => {
  try {
    const docs = await tasks.find().sort({ createdAt: 1 }).toArray();
    res.json(docs.map(out));
  } catch (e) {
    res.status(500).json({ error: "Could not load tasks" });
  }
});

app.post("/api/tasks", requireAuth, async (req, res) => {
  try {
    const doc = clean(req.body || {});
    if (!doc.title) return res.status(400).json({ error: "Title is required" });
    doc.createdAt = Date.now();
    const r = await tasks.insertOne(doc);
    res.json(out({ ...doc, _id: r.insertedId }));
  } catch (e) {
    res.status(500).json({ error: "Could not create task" });
  }
});

app.patch("/api/tasks/:id", requireAuth, async (req, res) => {
  let _id;
  try { _id = new ObjectId(req.params.id); }
  catch { return res.status(400).json({ error: "Bad id" }); }
  try {
    const set = clean(req.body || {}, { partial: true });
    // Record (or clear) the completion time so tasks can auto-archive 2 weeks later.
    if ("done" in set) set.completedAt = set.done ? Date.now() : null;
    await tasks.updateOne({ _id }, { $set: set });
    const doc = await tasks.findOne({ _id });
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(out(doc));
  } catch (e) {
    res.status(500).json({ error: "Could not update task" });
  }
});

app.delete("/api/tasks/:id", requireAuth, async (req, res) => {
  let _id;
  try { _id = new ObjectId(req.params.id); }
  catch { return res.status(400).json({ error: "Bad id" }); }
  try {
    await tasks.deleteOne({ _id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Could not delete task" });
  }
});

// Public branding (title + subtitle) for the login screen, which renders before sign-in.
app.get("/api/branding", async (req, res) => {
  try {
    const doc = await settingsCol.findOne({ _id: "app" });
    res.json({ title: (doc && doc.title) || "Task Desk", subtitle: (doc && typeof doc.subtitle === "string") ? doc.subtitle : "Control & Automation" });
  } catch (e) { res.json({ title: "Task Desk", subtitle: "Control & Automation" }); }
});

// ---- app settings (people & classes, editable in-app) ----
const cleanList = (arr, fallback) => {
  if (!Array.isArray(arr)) return fallback;
  const seen = new Set(), out = [];
  for (const x of arr) { const s = String(x || "").trim(); if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); } }
  return out.length ? out : fallback;
};
app.get("/api/settings", requireAuth, async (req, res) => {
  try {
    const doc = await settingsCol.findOne({ _id: "app" });
    res.json({
      people: (doc && doc.people) || DEFAULT_PEOPLE,
      classes: (doc && doc.classes) || DEFAULT_CLASSES,
      title: (doc && doc.title) || "Task Desk",
      subtitle: (doc && typeof doc.subtitle === "string") ? doc.subtitle : "Control & Automation",
    });
  } catch (e) { res.status(500).json({ error: "Could not load settings" }); }
});
app.put("/api/settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const people = cleanList(req.body && req.body.people, DEFAULT_PEOPLE);
    const classes = cleanList(req.body && req.body.classes, DEFAULT_CLASSES);
    const title = (String((req.body && req.body.title) || "").trim()) || "Task Desk";
    const subtitle = String((req.body && req.body.subtitle) || "").trim();   // may be blank
    await settingsCol.updateOne({ _id: "app" }, { $set: { people, classes, title, subtitle } }, { upsert: true });
    res.json({ people, classes, title, subtitle });
  } catch (e) { res.status(500).json({ error: "Could not save settings" }); }
});

// ---- project templates ----
app.get("/api/templates", requireAuth, async (req, res) => {
  try {
    const docs = await templatesCol.find().sort({ name: 1 }).toArray();
    res.json(docs.map(templateOut));
  } catch (e) { res.status(500).json({ error: "Could not load templates" }); }
});

app.post("/api/templates", requireAuth, async (req, res) => {
  try {
    const t = cleanTemplate(req.body);
    if (!t.name || !t.phases.length) return res.status(400).json({ error: "A template needs a name and at least one phase" });
    const r = await templatesCol.insertOne(t);
    res.json(templateOut({ ...t, _id: r.insertedId }));
  } catch (e) { res.status(500).json({ error: "Could not save template" }); }
});

app.put("/api/templates/:id", requireAuth, async (req, res) => {
  let _id; try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Bad id" }); }
  try {
    const t = cleanTemplate(req.body);
    if (!t.name || !t.phases.length) return res.status(400).json({ error: "A template needs a name and at least one phase" });
    await templatesCol.updateOne({ _id }, { $set: t });
    const doc = await templatesCol.findOne({ _id });
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(templateOut(doc));
  } catch (e) { res.status(500).json({ error: "Could not update template" }); }
});

app.delete("/api/templates/:id", requireAuth, async (req, res) => {
  let _id; try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Bad id" }); }
  try { await templatesCol.deleteOne({ _id }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: "Could not delete template" }); }
});

app.post("/api/projects/from-template", requireAuth, async (req, res) => {
  try {
    const { templateId, so, customer, startDate, assignments, dues: clientDues } = req.body || {};
    let _tid; try { _tid = new ObjectId(templateId); } catch { return res.status(400).json({ error: "Unknown template" }); }
    const tpl = await templatesCol.findOne({ _id: _tid });
    if (!tpl) return res.status(400).json({ error: "Unknown template" });
    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return res.status(400).json({ error: "Pick a valid start date" });
    const project = [String(so || "").trim(), String(customer || "").trim()].filter(Boolean).join(" ");
    if (!project) return res.status(400).json({ error: "Enter an SO number or customer" });

    // Use the dates from the dialog (which the user may have adjusted) when they're valid; otherwise schedule them.
    const validDues = Array.isArray(clientDues) && clientDues.length === tpl.phases.length
      && clientDues.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const dues = validDues ? clientDues : scheduleDues(startDate, tpl.phases);
    const now = Date.now();
    const docs = tpl.phases.map((p, i) => ({
      title: p.name,
      who: (assignments && assignments[i]) ? String(assignments[i]) : (p.pool[0] || ""),
      cls: Array.isArray(p.cls) ? p.cls : [],
      project,
      due: dues[i],
      notes: "",
      done: false,
      completedAt: null,
      createdAt: now + i,
    }));
    const r = await tasks.insertMany(docs);
    const created = docs.map((d, i) => out({ ...d, _id: r.insertedIds[i] }));
    res.json({ tasks: created, project });
  } catch (e) {
    console.error("from-template error", e);
    res.status(500).json({ error: "Could not create the project" });
  }
});

// ---- AI assistant ----
app.post("/api/assistant", requireAuth, async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(400).json({ error: "The assistant isn't set up yet — add ANTHROPIC_API_KEY in your host's environment settings, then redeploy." });
  }
  try {
    const { message, history, classes, people } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: "Empty message" });

    const docs = await tasks.find().sort({ createdAt: 1 }).toArray();
    const taskList = docs.map((d) => {
      const o = out(d);
      return { id: o.id, title: o.title, who: o.who, cls: o.cls, project: o.project, due: o.due, done: o.done };
    });

    const tplDocs = await templatesCol.find().sort({ name: 1 }).toArray();
    const templateInfo = tplDocs.map((t) => ({
      name: t.name,
      phases: (t.phases || []).map((p) => ({ name: p.name, durationDays: p.durationDays, pool: p.pool || [] })),
    }));

    const today = new Date().toISOString().slice(0, 10);
    const dow = new Date().toLocaleDateString("en-US", { weekday: "long" });

    const system = `You are the assistant built into "Task Desk", a control & automation task tracker used by a small team.
Today is ${dow}, ${today}.
Valid people (assignees): ${JSON.stringify(people || [])}.
Valid classes (a task may have zero or more of these): ${JSON.stringify(classes || [])}.
Current tasks (JSON array): ${JSON.stringify(taskList)}.
Available project templates (JSON array): ${JSON.stringify(templateInfo)}.

You help the user capture new tasks, answer questions about the team's workload, make bulk edits, break a big job into a set of tasks, and launch whole projects from a template — using ONLY the data above. Do not invent tasks that already exist. Interpret relative dates like "Friday" or "next week" into real dates based on today.

Respond with ONLY a raw JSON object, no markdown fences and no text outside it:
{"reply": string, "actions": Action[]}
Where each Action is one of:
{"type":"create","task":{"title":string,"who":string,"cls":string[],"project":string,"due":"YYYY-MM-DD"|"","notes":string}}
{"type":"update","id":string,"changes":{ }}   // changes may include any of: title, who, cls (string[]), project, due, notes, done (boolean)
{"type":"delete","id":string}
{"type":"shift","days":number,"businessDays":boolean,"scope":"all"|"open"|"overdue"|"done","project":string,"who":string,"ids":string[]}
{"type":"project","template":string,"so":string,"customer":string,"startDate":"YYYY-MM-DD","assignees":{}}
{"type":"template","name":string,"phases":[{"name":string,"durationDays":number,"cls":string[],"pool":string[]}]}
Rules:
- "who" must be exactly one of the valid people, or "" if unassigned.
- "cls" items must be exactly from the valid classes list; use [] if none apply.
- update/delete "id" must be an existing task id from Current tasks.
- BULK EDITS: when a request changes a FIELD on several tasks (e.g. "move all of Aaron's open tasks to Jack", "re-tag Documentation as Manuals"), return one "update" action per matching task — don't skip any.
- SHIFT DATES IN BULK: when the user wants to move many tasks' DEADLINES by an amount of time (e.g. "push all tasks a week", "move everything overdue out 3 days", "shift the Acme project 2 days earlier", "bump Gil's open tasks by 5 days"), return a SINGLE "shift" action instead of per-task updates. Set "days" (positive = later, negative = earlier), "businessDays" true only if they mean working days, and narrow the set with "scope" ("all"/"open"/"overdue"/"done"; default "open"), plus optional "project", "who", or explicit "ids". Do NOT calculate the new dates yourself and do NOT emit per-task "update" actions for a time shift — the app computes every new date exactly. Leave unused filters out.
- BREAK DOWN A JOB: when the user describes a larger ad-hoc job with no matching template, return several "create" actions covering the phases.
- LAUNCH A PROJECT: when the user asks to start/create a project that matches a template by name (e.g. "start a Sales Order for Acme, SO-1234, Monday"), return a SINGLE "project" action. "template" must exactly match one of the Available project templates' names. Put the order/SO number in "so" and the customer in "customer". Resolve the start date. If you have neither an SO number nor a customer, ask for it in "reply" instead of emitting the action. The app fills each phase's assignee (least-loaded from its pool) and computes the schedule — you do NOT list the phase tasks yourself.
- TWEAK A PROPOSED PROJECT: if the user adjusts a project you just proposed (e.g. "push the start a week", "give PLC to Gil"), re-emit the SINGLE "project" action with the change applied — set the new "startDate", and/or put per-phase assignee overrides in "assignees" as { "<exact phase name>": "<person>" }. Only include phases the user specifically named; leave "assignees" as {} otherwise.
- BUILD A TEMPLATE: when the user asks to create or save a template (e.g. "make a Retrofit template with these phases…"), return a SINGLE "template" action. Each phase needs a name, a durationDays (business days), cls from the valid classes, and a pool of eligible people from the valid people. Tell the user in "reply" to review and Save it.
- Use actions ONLY when the user wants to add or change things. For questions, "actions" must be [].
- Keep "reply" short and friendly. When you propose actions, briefly say what you're proposing and tell the user to review and Apply (or Apply all / Save).`;

    const messages = [];
    (Array.isArray(history) ? history : []).slice(-8).forEach((h) => {
      if (h && (h.role === "user" || h.role === "assistant") && h.content) messages.push({ role: h.role, content: String(h.content) });
    });
    messages.push({ role: "user", content: String(message) });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: ASSISTANT_MODEL, max_tokens: 2048, system, messages }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("Anthropic API error", r.status, detail.slice(0, 500));
      const msg = r.status === 401 ? "The API key was rejected — double-check ANTHROPIC_API_KEY."
        : r.status === 429 ? "Rate limited or out of credit — check your Anthropic billing."
        : "The assistant service returned an error.";
      return res.status(502).json({ error: msg });
    }

    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

    let parsed;
    try { parsed = JSON.parse(stripFences(text)); }
    catch { parsed = { reply: text || "Sorry, I couldn't parse that.", actions: [] }; }
    if (!parsed || typeof parsed !== "object") parsed = { reply: "Sorry, I couldn't parse that.", actions: [] };

    res.json({
      reply: typeof parsed.reply === "string" ? parsed.reply : "",
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    });
  } catch (e) {
    console.error("assistant error", e);
    res.status(500).json({ error: "The assistant failed to respond." });
  }
});

// ---- start ----
const PORT = process.env.PORT || 3000;
const DB_NAME = process.env.DB_NAME || "taskdesk";   // set a different name to run a second, separate instance on the same cluster
async function start() {
  await client.connect();
  const db = client.db(DB_NAME);
  tasks = db.collection("tasks");
  await tasks.createIndex({ createdAt: 1 });
  templatesCol = db.collection("templates");
  if ((await templatesCol.countDocuments()) === 0) {
    await templatesCol.insertMany(DEFAULT_TEMPLATES.map((t) => ({ name: t.name, phases: t.phases })));
  }
  settingsCol = db.collection("settings");
  if ((await settingsCol.countDocuments({ _id: "app" })) === 0) {
    await settingsCol.insertOne({ _id: "app", people: DEFAULT_PEOPLE, classes: DEFAULT_CLASSES, title: "Task Desk", subtitle: "Control & Automation" });
  }
  usersCol = db.collection("users");
  // Seed member accounts on first run (from INIT_USER, else the legacy trio).
  if ((await usersCol.countDocuments({ role: { $ne: "admin" } })) === 0) {
    const seeds = [];
    if (process.env.INIT_USER) {
      seeds.push([process.env.INIT_USER, process.env.INIT_USER, process.env.INIT_PASSWORD || "changeme"]);
    } else {
      [["froy", "Froy", process.env.FROY_PASSWORD], ["miguel", "Miguel", process.env.MIGUEL_PASSWORD], ["gil", "Gil", process.env.GIL_PASSWORD]]
        .forEach((x) => { if (x[2]) seeds.push(x); });
    }
    for (const [u, n, pw] of seeds) {
      const id = slugUser(u); if (!id || id === "admin") continue;
      if (await usersCol.findOne({ _id: id })) continue;
      const { salt, hash } = hashPassword(pw);
      await usersCol.insertOne({ _id: id, name: n, role: "member", salt, hash });
    }
  }
  // The built-in Admin always exists (full permissions). Password from ADMIN_PASSWORD on first creation, else "admin".
  if (!(await usersCol.findOne({ _id: "admin" }))) {
    const { salt, hash } = hashPassword(process.env.ADMIN_PASSWORD || "admin");
    await usersCol.insertOne({ _id: "admin", name: "Admin", role: "admin", salt, hash });
  } else {
    await usersCol.updateOne({ _id: "admin" }, { $set: { role: "admin" } });   // never let Admin lose admin
  }
  await refreshUserCache();
  app.listen(PORT, () => console.log(`\n  Task Desk running:  http://localhost:${PORT}\n`));
}
start().catch((e) => {
  console.error("Failed to start. Check your Atlas connection string and network access list.\n", e.message);
  process.exit(1);
});
