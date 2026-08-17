import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import * as chrono from "chrono-node";

interface Task {
  id: string;
  title: string;
  due: number; // epoch milliseconds
  remindBefore: number; // minutes before the deadline for an early heads-up; 0 = none
  reminded: boolean; // early reminder already fired
  notified: boolean; // deadline notification already fired
  done: boolean;
}

let tasks: Task[] = [];
let editingId: string | null = null; // which task we're editing, if any

const $ = (id: string) => document.getElementById(id)!;
const titleEl = $("title") as HTMLInputElement;
const whenEl = $("when") as HTMLInputElement;
const remindEl = $("remind") as HTMLSelectElement;
const previewEl = $("preview");
const listEl = $("list");
const emptyEl = $("empty");
const addBtn = $("add") as HTMLButtonElement;
const cancelBtn = $("cancel") as HTMLButtonElement;
const clearBtn = $("clearDone") as HTMLButtonElement;

// --- Notification permission (asked once) ---
async function ensurePermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  return granted;
}

// --- Persistence (delegated to Rust, writes tasks.json in the app data dir) ---
async function loadTasks() {
  try {
    const parsed = JSON.parse(await invoke<string>("load_tasks")) as Partial<Task>[];
    // Fill in defaults so tasks saved by the older version still load cleanly.
    tasks = parsed.map((t) => ({
      id: t.id ?? crypto.randomUUID(),
      title: t.title ?? "(untitled)",
      due: t.due ?? Date.now(),
      remindBefore: t.remindBefore ?? 0,
      reminded: t.reminded ?? false,
      notified: t.notified ?? false,
      done: t.done ?? false,
    }));
  } catch {
    tasks = [];
  }
}
async function persist() {
  await invoke("save_tasks", { data: JSON.stringify(tasks) });
}

function fmt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
// A format chrono can reliably parse back when we reload a task into the editor.
function toEditable(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// --- Live preview: show how the natural-language date was understood ---
function updatePreview() {
  const text = whenEl.value.trim();
  if (!text) {
    previewEl.textContent = "";
    previewEl.removeAttribute("data-ok");
    return;
  }
  const date = chrono.parseDate(text);
  if (!date) {
    previewEl.textContent = "Couldn't read that date — try 'Friday 5pm' or 'in 3 hours'.";
    previewEl.dataset.ok = "false";
  } else {
    previewEl.textContent = "\u2192 " + fmt(date.getTime());
    previewEl.dataset.ok = "true";
  }
}

function render() {
  listEl.innerHTML = "";
  // Unfinished tasks first (soonest deadline on top), completed ones last.
  const sorted = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return a.due - b.due;
  });
  emptyEl.style.display = sorted.length ? "none" : "block";
  clearBtn.style.display = tasks.some((t) => t.done) ? "block" : "none";

  for (const t of sorted) {
    const li = document.createElement("li");
    li.className = "item";
    if (t.done) li.classList.add("done");
    else if (t.due < Date.now()) li.classList.add("overdue");

    // Done checkbox
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "check";
    check.checked = t.done;
    check.onchange = async () => {
      t.done = check.checked;
      await persist();
      render();
    };

    // Title + due line
    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "item-title";
    name.textContent = t.title;
    const due = document.createElement("div");
    due.className = "item-due";
    due.textContent = fmt(t.due) + (t.remindBefore ? ` \u00b7 ${t.remindBefore} min reminder` : "");
    info.append(name, due);

    // Edit + delete buttons
    const edit = document.createElement("button");
    edit.className = "icon";
    edit.textContent = "\u270e";
    edit.title = "Edit";
    edit.onclick = () => startEdit(t.id);

    const del = document.createElement("button");
    del.className = "icon del";
    del.textContent = "\u2715";
    del.title = "Delete";
    del.onclick = async () => {
      tasks = tasks.filter((x) => x.id !== t.id);
      if (editingId === t.id) cancelEdit();
      await persist();
      render();
    };

    li.append(check, info, edit, del);
    listEl.append(li);
  }
}

function startEdit(id: string) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  editingId = id;
  titleEl.value = t.title;
  whenEl.value = toEditable(t.due);
  remindEl.value = String(t.remindBefore);
  updatePreview();
  addBtn.textContent = "Save changes";
  cancelBtn.style.display = "inline-block";
  titleEl.focus();
}

function cancelEdit() {
  editingId = null;
  titleEl.value = "";
  whenEl.value = "";
  remindEl.value = "0";
  previewEl.textContent = "";
  previewEl.removeAttribute("data-ok");
  addBtn.textContent = "Add task";
  cancelBtn.style.display = "none";
}

async function submit() {
  const title = titleEl.value.trim();
  const date = chrono.parseDate(whenEl.value.trim());
  const remindBefore = Number(remindEl.value);
  if (!title) return alert("Give the task a name.");
  if (!date) return alert("Couldn't understand the deadline. Try 'Friday 5pm' or 'tomorrow 9am'.");

  const due = date.getTime();
  const now = Date.now();
  // Don't fire for moments already in the past.
  const reminded = due - remindBefore * 60_000 <= now;
  const notified = due <= now;

  if (editingId) {
    // Update the existing task and reset its fire-flags so a reschedule can alert again.
    const t = tasks.find((x) => x.id === editingId);
    if (t) {
      t.title = title;
      t.due = due;
      t.remindBefore = remindBefore;
      t.reminded = reminded;
      t.notified = notified;
    }
  } else {
    tasks.push({
      id: crypto.randomUUID(),
      title,
      due,
      remindBefore,
      reminded,
      notified,
      done: false,
    });
  }

  await persist();
  cancelEdit();
  render();
}

// --- The scheduler: checks every 30s, fires the early reminder then the deadline ---
async function checkDeadlines() {
  const now = Date.now();
  let changed = false;
  for (const t of tasks) {
    if (t.done) continue;

    // Early heads-up
    if (!t.reminded && t.remindBefore > 0) {
      const remindAt = t.due - t.remindBefore * 60_000;
      if (remindAt <= now && now < t.due) {
        sendNotification({ title: "Coming up", body: `${t.title} \u2014 due at ${fmtTime(t.due)}` });
        t.reminded = true;
        changed = true;
      }
    }

    // At the deadline
    if (!t.notified && t.due <= now) {
      sendNotification({ title: "Task due", body: t.title });
      t.notified = true;
      changed = true;
    }
  }
  if (changed) {
    await persist();
    render();
  }
}

async function main() {
  await ensurePermission();
  await loadTasks();
  render();

  whenEl.addEventListener("input", updatePreview);
  addBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", cancelEdit);
  clearBtn.addEventListener("click", async () => {
    tasks = tasks.filter((t) => !t.done);
    await persist();
    render();
  });
  whenEl.addEventListener("keydown", (e) => e.key === "Enter" && submit());

  checkDeadlines();
  setInterval(checkDeadlines, 30_000);
}

main();