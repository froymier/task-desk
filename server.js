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
const USERS = {
  froy:   { name: "Froy",   password: process.env.FROY_PASSWORD },
  miguel: { name: "Miguel", password: process.env.MIGUEL_PASSWORD },
  gil:    { name: "Gil",    password: process.env.GIL_PASSWORD },
};
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

function passwordMatches(input, actual) {
  if (!actual || typeof input !== "string") return false;
  const a = Buffer.from(input), b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  if (!username || !USERS[username]) return res.status(401).json({ error: "Not signed in" });
  req.username = username;
  next();
}

app.post("/api/login", (req, res) => {
  const username = String((req.body && req.body.username) || "").trim().toLowerCase();
  const password = (req.body && req.body.password) || "";
  const user = USERS[username];
  if (!user || !passwordMatches(password, user.password)) {
    return res.status(401).json({ error: "Wrong user or password" });
  }
  setSessionCookie(req, res, makeToken(username));
  res.json({ name: user.name });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ name: USERS[req.username].name });
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
async function start() {
  await client.connect();
  tasks = client.db("taskdesk").collection("tasks");
  await tasks.createIndex({ createdAt: 1 });
  templatesCol = client.db("taskdesk").collection("templates");
  if ((await templatesCol.countDocuments()) === 0) {
    await templatesCol.insertMany(DEFAULT_TEMPLATES.map((t) => ({ name: t.name, phases: t.phases })));
  }
  app.listen(PORT, () => console.log(`\n  Task Desk running:  http://localhost:${PORT}\n`));
}
start().catch((e) => {
  console.error("Failed to start. Check your Atlas connection string and network access list.\n", e.message);
  process.exit(1);
});
