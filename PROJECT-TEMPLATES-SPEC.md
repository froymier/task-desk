# Feature Spec — Project Templates (Presets)

## 1. Problem & goal
Recurring project types (e.g. **Sales Order**) always run through the same phases with the same durations, class tags, and eligible people. Today each new project's tasks are created or duplicated one at a time — slow (15+ min) and error-prone. 

**Goal:** create a whole project's worth of tasks from a saved template in under two minutes, entering only what actually changes (SO number, customer, start date), with all downstream deadlines calculated automatically.

## 2. Scope

**In scope (v1)**
- Save a reusable **template**: an ordered list of phases, each with a name, duration, class tags, and a pool of eligible assignees.
- **Create a project from a template**: pick a template, enter SO number + customer + start date, pick one assignee per phase from its pool, preview, and generate all tasks in one action.
- **Automatic due dates**: each phase is scheduled sequentially from the start date using its duration (business days).
- Generated tasks use the existing task fields — so they immediately work with the board, calendar, dashboard, and archive.
- A built-in **"Sales Order"** template seeded from the team's current workflow.

**Out of scope (v1 — noted for later)**
- Parallel/overlapping phases and explicit task dependencies (v1 is strictly sequential).
- Per-phase multiple simultaneous assignees (v1 = one assignee per generated task).
- Editing an already-generated project as a unit (edit tasks individually as today).
- Template versioning / history.

## 3. Core concepts & data model

A **template** is stored in a new MongoDB collection `templates`:

```
Template {
  id
  name            // "Sales Order"
  titlePrefix     // optional, e.g. "" or "SO"
  phases: [
    {
      name        // "Design Schematics"      -> becomes the task title
      durationDays// 5   (business days)
      cls: []     // ["Schematics / Panels"]  -> class tags
      pool: []    // ["Ben","Tono","Alejandra","Javier","Angel B"]  eligible assignees
      defaultWho  // optional preselected assignee
    }, ...
  ]
  createdAt
}
```

A **generated task** (existing shape) is produced per phase:
- `title` = phase name
- `project` = `"<SO number> <customer>"` (e.g. `"SO-1234 Acme"`) — groups them via the existing project field
- `cls` = phase class tags
- `who` = the assignee chosen at creation
- `due` = the computed phase end date
- `notes` = optional (e.g. carries the phase order / template name)

Because `project` is the existing field, the generated tasks light up the **Progress-by-project** dashboard bar and the **By project** view for free.

## 4. Key design decision — the assignee "pool"
Each phase lists several people (e.g. Design Schematics → Ben, Tono, Alejandra, Javier, Angel B). A Task Desk task has **one** assignee, so the template treats that list as a **pool of eligible people**, and at project-creation the user (or the AI) picks **one** per phase. 

Recommended default: preselect the least-loaded person from the pool (or a stored `defaultWho`), editable before creating. 

*Alternative if you'd rather:* generate one task per person in the pool (more tasks), or leave phases unassigned with the pool listed in notes. The spec assumes **pick-one-from-pool**; easy to change.

## 5. Due-date calculation
Sequential (waterfall) scheduling in **business days** (skip Sat/Sun):
- Phase 1 starts on the chosen **start date**; its due date = start + (duration − 1) business days.
- Phase _n_ starts the next business day after phase _n−1_'s due date; due = start + (duration − 1) business days.

Example, start = Mon Jun 1:
| Phase | Duration | Due |
|---|---|---|
| Design Schematics | 1 wk (5) | Fri Jun 5 |
| Review Schematics | 1 day | Mon Jun 8 |
| PLC Programming | 1 wk | Fri Jun 12 |
| HMI Programming | 1 wk | Fri Jun 19 |
| Testing & Commissioning | 1 wk | Fri Jun 26 |
| Serial Plates Manufacture | 2 days | Tue Jun 30 |

(Calendar-day mode can be offered as a toggle; business days is the sensible default for shop work.)

## 6. UI / UX

**A. Entry point** — a **"New project"** button (next to "Add task" in the Tasks header, and offered by the AI). Opens the create-from-template dialog.

**B. Create-from-template dialog**
- **Template** dropdown (e.g. "Sales Order").
- **SO number**, **Customer**, **Start date** fields.
- A live **phase table**: each row shows the phase name, its class tags, an **assignee dropdown** limited to that phase's pool (pre-filled with the suggested person), and the **auto-computed due date** (updates instantly as the start date changes).
- **Preview count** ("Creates 6 tasks under project SO-1234 Acme").
- **Create project** button → generates all tasks, closes, lands you on that project.

**C. Template manager** (v1 can ship with just the seeded Sales Order template; manager is a fast-follow)
- List of templates; create/edit/delete.
- Edit view: reorder phases (drag), set name/duration/class tags/pool per phase.

## 7. Implementation approach

**Server (`server.js`)**
- New collection `templates`. Endpoints (all `requireAuth`):
  - `GET /api/templates` — list.
  - `POST /api/templates` / `PATCH /api/templates/:id` / `DELETE /api/templates/:id` — manage (fast-follow; v1 can seed one template on startup).
  - `POST /api/projects/from-template` — body `{ templateId, so, customer, startDate, assignments: {phaseIndex: who} }`. Server loads the template, computes dates, inserts all tasks in one call, returns the created tasks.
- Business-day date helper lives server-side so scheduling is authoritative.

**Frontend (`index.html`)**
- "New project" button + dialog (reuses existing modal styling).
- Calls `/api/projects/from-template`, then merges the returned tasks into local state and re-renders.
- Assignee dropdowns are populated from each phase's pool.

**Phasing**
1. **MVP** — seed the Sales Order template + create-from-template dialog + batch endpoint + business-day math. *Solves the stated problem.*
2. **Template manager** — UI to create/edit templates without code.
3. **Enhancements** — parallel phases, dependencies, calendar-day toggle, AI auto-assignment.

## 8. How the AI agent helps
The assistant already proposes tasks; templates make it deterministic and let it drive the whole flow by voice/text:
- **Kick off by sentence:** *"Start a Sales Order for Acme, SO-1234, starting Monday"* → the agent runs the template, proposes all six tasks with dates and suggested assignees as cards, and you **Apply all**.
- **Smart assignment:** it fills each phase's assignee from the pool by picking whoever is **least loaded** right now (reading the same workload the dashboard shows), instead of a fixed default.
- **Build templates from words:** *"Make a template called Retrofit with these phases…"* → it drafts the template for you to save.
- **Adjust on the fly:** *"Same SO but push the start to next week"* or *"give PLC Programming to Gil"* before you apply.
- **Report across projects:** *"Which Sales Orders are behind?"* using the project grouping the template creates.

The template feature and the agent are complementary: the template guarantees the structure and dates; the agent removes the clicks and adds the workload-aware assignment.

## 9. Decisions needed before build
1. **Assignee model:** pick-one-from-pool (recommended) vs one-task-per-person vs unassigned+pool-in-notes.
2. **Durations:** business days (recommended) vs calendar days.
3. **Project naming:** `"SO-1234 Acme"` format for the `project` field — confirm the convention.
4. **Where "New project" lives:** Tasks header button (recommended), and/or a dedicated Templates tab.
