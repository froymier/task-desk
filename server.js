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

const client = new MongoClient(uri);
let tasks; // the MongoDB collection

// Shape a database document into what the frontend expects.
const out = (d) => ({
  id: d._id.toString(),
  title: d.title,
  who: d.who || "",
  cls: d.cls || "",
  due: d.due || "",
  notes: d.notes || "",
  done: !!d.done,
  createdAt: d.createdAt,
});

// Keep only fields we allow clients to set.
function clean(body, { partial } = {}) {
  const allowed = ["title", "who", "cls", "due", "notes", "done"];
  const obj = {};
  for (const k of allowed) {
    if (k in body) {
      if (k === "done") obj[k] = !!body[k];
      else if (typeof body[k] === "string") obj[k] = body[k].trim();
      else obj[k] = body[k];
    }
  }
  if (!partial) {
    obj.title = (obj.title || "").trim();
    obj.who = obj.who || "";
    obj.cls = obj.cls || "";
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

// ---- routes ----
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

// ---- start ----
const PORT = process.env.PORT || 3000;
async function start() {
  await client.connect();
  tasks = client.db("taskdesk").collection("tasks");
  await tasks.createIndex({ createdAt: 1 });
  app.listen(PORT, () => console.log(`\n  Task Desk running:  http://localhost:${PORT}\n`));
}
start().catch((e) => {
  console.error("Failed to start. Check your Atlas connection string and network access list.\n", e.message);
  process.exit(1);
});
