# Task Desk

Your personal task organizer (assignees, deadlines, notes, "due this week"), now backed by **MongoDB Atlas** so it persists in the cloud and syncs across every device.

## What's in here

```
task-desk/
├── server.js          the backend (Express + MongoDB)
├── package.json       dependencies
├── .env.example       template for your Atlas connection string
├── .gitignore
└── public/
    └── index.html     the app UI (what you already had)
```

---

## One-time setup

### 1. Install Node.js
If you don't have it, download the **LTS** version from https://nodejs.org and install it. To check it worked, open a terminal and run `node -v` — you should see a version number.

### 2. Create your free Atlas database
1. Go to https://www.mongodb.com/atlas and sign up (free).
2. Create a **free (M0) cluster** — any cloud/region is fine.
3. **Database Access** → *Add New Database User*. Pick a username and password and save them (you'll need the password in a moment).
4. **Network Access** → *Add IP Address* → choose **Allow access from anywhere** (fine for a personal project), or add your current IP.
5. **Database** → *Connect* → *Drivers* → copy the connection string. It looks like:
   `mongodb+srv://USER:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`

### 3. Add your connection string and secrets
1. In this folder, make a copy of `.env.example` and name it `.env`.
2. Open `.env` and fill in:
   - `MONGODB_URI` — your Atlas string (replace `<password>` with the DB user's password).
   - `SESSION_SECRET` — a long random string. Generate one with:
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `FROY_PASSWORD`, `MIGUEL_PASSWORD`, `GIL_PASSWORD` — pick a password for each person.

### Who can sign in
Three users can log in: **Froy**, **Miguel**, and **Gil**. Each signs in with the password you set in `.env`. The app remembers them for 30 days, and whoever logs in sees their own tasks pinned to the top. Tasks can still be *assigned* to any of the 14 people — but only these three can open the app. To change a password, edit `.env` (or your host's environment settings) and restart; to add a person, tell me and I'll wire them in.

### 4. Install and run
In a terminal, from inside this folder:

```
npm install
npm start
```

You'll see `Task Desk running: http://localhost:3000`. Open that in your browser.

---

## Daily use
Just run `npm start` and open http://localhost:3000. Your tasks live in Atlas now, so they're the same no matter which machine you open it from.

## Seeing it on your phone (optional)
Because the data is in Atlas, any device that runs this app shares the same tasks. The simplest way to reach it from your phone is to deploy the project to a free host like **Render** — point it at this folder, set the same environment variables there (`MONGODB_URI`, `SESSION_SECRET`, and the three passwords) in the host's settings, and you'll get a public URL you can open anywhere. Happy to walk you through that step when you're ready.

## Notes
- `.env` holds your password — it's already in `.gitignore`, so it won't be committed if you push this to GitHub.
- Tasks are stored in a database called `taskdesk`, collection `tasks`. You can browse them anytime in **MongoDB Compass** or in the Atlas web UI under *Browse Collections*.
