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
  notified: boolean;
}

let tasks: Task[] = [];

const $ = (id: string) => document.getElementById(id)!;
const titleEl = $("title") as HTMLInputElement;
const whenEl = $("when") as HTMLInputElement;
const previewEl = $("preview");
const listEl = $("list");
const emptyEl = $("empty");

// --- Notification permission (asked once) ---
async function ensurePermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  return granted;
}

// --- Persistence (delegated to Rust, writes tasks.json in the app data dir) ---
async function loadTasks() {
  try {
    tasks = JSON.parse(await invoke<string>("load_tasks"));
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

// --- Live preview: show how the natural-language date was understood ---
function updatePreview() {
  const text = whenEl.value.trim();
  if (!text) {
    previewEl.textContent = "";
    return;
  }
  const date = chrono.parseDate(text);
  if (!date) {
    previewEl.textContent = "Couldn't read that date — try 'Friday 5pm' or 'in 3 hours'.";
    previewEl.dataset.ok = "false";
  } else {
    previewEl.textContent = "→ " + fmt(date.getTime());
    previewEl.dataset.ok = "true";
  }
}

function render() {
  listEl.innerHTML = "";
  const sorted = [...tasks].sort((a, b) => a.due - b.due);
  emptyEl.style.display = sorted.length ? "none" : "block";

  for (const t of sorted) {
    const li = document.createElement("li");
    li.className = "item" + (t.due < Date.now() ? " overdue" : "");

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "item-title";
    name.textContent = t.title;
    const due = document.createElement("div");
    due.className = "item-due";
    due.textContent = fmt(t.due);
    info.append(name, due);

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.onclick = async () => {
      tasks = tasks.filter((x) => x.id !== t.id);
      await persist();
      render();
    };

    li.append(info, del);
    listEl.append(li);
  }
}

async function addTask() {
  const title = titleEl.value.trim();
  const date = chrono.parseDate(whenEl.value.trim());
  if (!title) return alert("Give the task a name.");
  if (!date) return alert("Couldn't understand the deadline. Try 'Friday 5pm' or 'tomorrow 9am'.");

  tasks.push({
    id: crypto.randomUUID(),
    title,
    due: date.getTime(),
    notified: date.getTime() <= Date.now(), // don't fire for a time already past
  });
  await persist();

  titleEl.value = "";
  whenEl.value = "";
  previewEl.textContent = "";
  render();
}

// --- The scheduler: checks every 30s and fires a notification at the deadline ---
async function checkDeadlines() {
  const now = Date.now();
  let changed = false;
  for (const t of tasks) {
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
  $("add").addEventListener("click", addTask);
  whenEl.addEventListener("keydown", (e) => e.key === "Enter" && addTask());

  checkDeadlines();
  setInterval(checkDeadlines, 30_000);
}

main();
