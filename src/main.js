const TAURI = window.__TAURI__;
const STORAGE_KEY = "projecttray.state.v1";

const PALETTE = [
  "#f4c15d",
  "#ff8f7a",
  "#7fb7ff",
  "#7adfb2",
  "#c6a7ff",
  "#f49bc5",
  "#a5e3e8",
  "#d8d4c8",
];

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

const ICONS = {
  check: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.4 6.25 2.3 2.25 4.9-5"/></svg>',
  close: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>',
  calendar: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2.6" width="8" height="7.2" rx="1.5"/><path d="M2.3 4.8h7.4M4.2 1.8v1.6M7.8 1.8v1.6"/></svg>',
  dots: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="13" cy="8" r="1.1"/></svg>',
  plus: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M2 6h8"/></svg>',
  chevronLeft: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m7.5 2.5-3.5 3.5 3.5 3.5"/></svg>',
  chevronRight: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5"/></svg>',
};

const dom = {
  backdrop: document.getElementById("backdrop"),
  grid: document.getElementById("project-grid"),
  todayLabel: document.getElementById("today-label"),
  projectSummary: document.getElementById("project-summary"),
  openCount: document.getElementById("open-count"),
  dueCount: document.getElementById("due-count"),
  saveStatus: document.getElementById("save-status"),
  saveLabel: document.getElementById("save-label"),
  popoverLayer: document.getElementById("popover-layer"),
  themeToggle: document.getElementById("theme-toggle"),
  toast: document.getElementById("toast"),
  toastMessage: document.getElementById("toast-message"),
  toastAction: document.getElementById("toast-action"),
};

let state = null;
let activePopover = null;
let calendarCursor = new Date();
let pendingFocus = null;
let saveTimer = null;
let saveInFlight = null;
let saveQueued = false;
let changeVersion = 0;
let savedVersion = 0;
let hiding = false;
let toastTimer = null;
let toastUndo = null;
let currentDayKey = todayKey();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return char;
    }
  });
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function startOfDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function toKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayKey() {
  return toKey(new Date());
}

function fromKey(key) {
  if (!isDateKey(key)) return null;
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dayDiff(key) {
  const due = fromKey(key);
  if (!due) return 0;
  return Math.round((startOfDay(due) - startOfDay(new Date())) / 86_400_000);
}

function longDate(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function fullDate(key) {
  const date = fromKey(key);
  if (!date) return "No due date";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function monthLabel(date) {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
}

function plural(count, singular, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function systemTheme() {
  return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function resolveTheme(value) {
  return value === "light" || value === "dark" ? value : systemTheme();
}

async function applyTheme(value, { persist = false } = {}) {
  const theme = resolveTheme(value);
  document.documentElement.dataset.theme = theme;

  if (dom.themeToggle) {
    const nextLabel = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
    dom.themeToggle.setAttribute("aria-label", nextLabel);
    dom.themeToggle.title = nextLabel;
  }

  if (state) state.theme = theme;

  if (TAURI?.core?.invoke) {
    try {
      await TAURI.core.invoke("set_theme", { theme });
    } catch (error) {
      console.error("ProjectTray could not update the window theme.", error);
    }
  }

  if (persist && state) markChanged();
  return theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  void applyTheme(next, { persist: true });
}

function dueInfo(key) {
  if (!key) {
    return { label: "Date", className: "is-none", title: "Set a due date" };
  }

  const date = fromKey(key);
  if (!date) {
    return { label: "Date", className: "is-none", title: "Set a due date" };
  }

  const diff = dayDiff(key);
  let label;
  let className = "";

  if (diff < -1) {
    label = `${Math.abs(diff)}d late`;
    className = "is-overdue";
  } else if (diff === -1) {
    label = "Yesterday";
    className = "is-overdue";
  } else if (diff === 0) {
    label = "Today";
    className = "is-today";
  } else if (diff === 1) {
    label = "Tomorrow";
  } else if (diff < 7) {
    label = `${WEEKDAYS_SHORT[date.getDay()]} ${date.getDate()}`;
  } else {
    label = `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
    if (date.getFullYear() !== new Date().getFullYear()) {
      label += ` ’${String(date.getFullYear()).slice(-2)}`;
    }
  }

  return { label, className, title: fullDate(key) };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function findProject(projectId) {
  return state.projects.find((project) => project.id === projectId);
}

function findTodo(projectId, todoId) {
  const project = findProject(projectId);
  if (!project) return { project: null, todo: null, index: -1 };
  const index = project.todos.findIndex((todo) => todo.id === todoId);
  return { project, todo: index >= 0 ? project.todos[index] : null, index };
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

function makeSeedState() {
  const today = new Date();
  const day = (offset) => toKey(addDays(today, offset));

  return {
    version: 1,
    theme: systemTheme(),
    projects: [
      {
        id: uid(),
        title: "ProjectTray",
        color: PALETTE[0],
        todos: [
          { id: uid(), title: "Sketch the overlay interaction", due: day(0), completed: false },
          { id: uid(), title: "Wire up the tray toggle", due: day(1), completed: false },
          { id: uid(), title: "Polish the project cards", due: day(3), completed: false },
          { id: uid(), title: "Pick a prototype stack", due: null, completed: true },
        ],
      },
      {
        id: uid(),
        title: "Website refresh",
        color: PALETTE[2],
        todos: [
          { id: uid(), title: "Write the new landing page copy", due: day(1), completed: false },
          { id: uid(), title: "Choose a type pairing", due: day(4), completed: false },
          { id: uid(), title: "Ship the hero section", due: day(8), completed: false },
          { id: uid(), title: "Audit the current site", due: null, completed: true },
        ],
      },
      {
        id: uid(),
        title: "Reading list",
        color: PALETTE[3],
        todos: [
          { id: uid(), title: "Finish The Creative Act", due: day(6), completed: false },
          { id: uid(), title: "Capture notes on deep work", due: null, completed: false },
          { id: uid(), title: "Choose the next read", due: null, completed: true },
        ],
      },
      {
        id: uid(),
        title: "Home studio",
        color: PALETTE[1],
        todos: [
          { id: uid(), title: "Measure the desk nook", due: day(-1), completed: false },
          { id: uid(), title: "Order the monitor arm", due: day(2), completed: false },
          { id: uid(), title: "Clear out the cable drawer", due: day(9), completed: false },
        ],
      },
    ],
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.projects)) return null;

  const projects = raw.projects
    .filter((project) => project && typeof project === "object")
    .map((project, projectIndex) => {
      const todos = Array.isArray(project.todos) ? project.todos : [];
      return {
        id: typeof project.id === "string" && project.id ? project.id : uid(),
        title: typeof project.title === "string" ? project.title : "Untitled project",
        color: PALETTE.includes(project.color)
          ? project.color
          : PALETTE[projectIndex % PALETTE.length],
        todos: todos
          .filter((todo) => todo && typeof todo === "object")
          .map((todo) => ({
            id: typeof todo.id === "string" && todo.id ? todo.id : uid(),
            title: typeof todo.title === "string" ? todo.title : "Untitled task",
            due: isDateKey(todo.due) ? todo.due : null,
            completed: Boolean(todo.completed),
          })),
      };
    });

  return { version: 1, theme: resolveTheme(raw.theme), projects };
}

async function loadInitialState() {
  let loaded = null;

  try {
    if (TAURI?.core?.invoke) {
      loaded = await TAURI.core.invoke("load_state");
    } else {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) loaded = JSON.parse(raw);
    }
  } catch (error) {
    console.error("ProjectTray could not load saved state.", error);
  }

  const normalized = loaded ? normalizeState(loaded) : null;
  if (normalized) {
    state = normalized;
    savedVersion = 0;
    changeVersion = 0;
    setSaveStatus("saved", "Saved");
    return;
  }

  state = makeSeedState();
  changeVersion = 1;
  setSaveStatus("saving", "Saving…");
  scheduleSave(180);
}

/* -------------------------------------------------------------------------- */
/* Save                                                                       */
/* -------------------------------------------------------------------------- */

function setSaveStatus(kind, label) {
  dom.saveStatus.classList.remove("is-saving", "is-error");
  if (kind === "saving") dom.saveStatus.classList.add("is-saving");
  if (kind === "error") dom.saveStatus.classList.add("is-error");
  dom.saveLabel.textContent = label;
}

function markChanged() {
  changeVersion += 1;
  setSaveStatus("saving", "Saving…");
  scheduleSave(450);
}

function scheduleSave(delay = 450) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, delay);
}

async function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  if (changeVersion === savedVersion) {
    setSaveStatus("saved", "Saved");
    return;
  }

  if (saveInFlight) {
    saveQueued = true;
    await saveInFlight;
    if (saveQueued) {
      saveQueued = false;
      return saveNow();
    }
    return;
  }

  const version = changeVersion;
  const snapshot = clone(state);
  saveInFlight = (async () => {
    try {
      if (TAURI?.core?.invoke) {
        await TAURI.core.invoke("save_state", { state: snapshot });
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      }
      savedVersion = version;
      if (changeVersion === version) {
        setSaveStatus("saved", "Saved");
      }
    } catch (error) {
      console.error("ProjectTray could not save state.", error);
      setSaveStatus("error", "Save failed");
    }
  })();

  await saveInFlight;
  saveInFlight = null;

  if (changeVersion !== savedVersion && dom.saveStatus.classList.contains("is-error") === false) {
    setSaveStatus("saving", "Saving…");
    scheduleSave(250);
  }
}

async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveNow();
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function renderAll() {
  renderChrome();
  renderGrid();
}

function renderChrome() {
  const open = state.projects.reduce(
    (total, project) => total + project.todos.filter((todo) => !todo.completed).length,
    0,
  );
  const dueSoon = state.projects.reduce(
    (total, project) =>
      total +
      project.todos.filter(
        (todo) => !todo.completed && todo.due && dayDiff(todo.due) <= 1,
      ).length,
    0,
  );

  dom.todayLabel.textContent = longDate();
  dom.projectSummary.textContent = plural(state.projects.length, "project");
  dom.openCount.textContent = String(open);
  dom.dueCount.textContent = String(dueSoon);
}

function renderGrid() {
  const gridScroll = dom.grid.scrollTop;
  const listScrolls = new Map(
    [...dom.grid.querySelectorAll(".todo-list")].map((list) => [list.dataset.projectId, list.scrollTop]),
  );

  if (state.projects.length === 0) {
    dom.grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <h2>Give your work a place to land.</h2>
        <p>Create a project, add the next few actions, and keep the important things one click away.</p>
        <button class="btn primary" data-action="new-project" type="button">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5"/></svg>
          New project
        </button>
      </div>`;
  } else {
    dom.grid.innerHTML = state.projects.map(renderProject).join("");
  }

  dom.grid.scrollTop = gridScroll;

  for (const list of dom.grid.querySelectorAll(".todo-list")) {
    const previous = listScrolls.get(list.dataset.projectId);
    if (typeof previous === "number") list.scrollTop = previous;
  }

  resizeTodoTitles();
  applyPendingFocus();
}

function renderProject(project) {
  const sortedTodos = [...project.todos].sort(
    (left, right) => Number(left.completed) - Number(right.completed),
  );
  const done = project.todos.filter((todo) => todo.completed).length;
  const total = project.todos.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const countLabel = total === 0 ? "No actions yet" : `${done} / ${total} done`;

  const todoMarkup = sortedTodos.map((todo) => renderTodo(project, todo)).join("");

  return `
    <article class="project-card" style="--accent:${escapeHtml(project.color)}" data-project-card="${escapeHtml(project.id)}">
      <header class="project-head">
        <div class="project-kicker">
          <span class="project-dot" aria-hidden="true"></span>
          <span class="project-count">${escapeHtml(countLabel)}</span>
        </div>
        <button class="project-menu-btn" type="button" data-action="project-menu" data-project-id="${escapeHtml(project.id)}" data-popover-anchor aria-label="Project options for ${escapeHtml(project.title || "Untitled project")}">
          ${ICONS.dots}
        </button>
      </header>

      <input
        class="project-title"
        type="text"
        value="${escapeHtml(project.title)}"
        data-project-id="${escapeHtml(project.id)}"
        aria-label="Project name"
        placeholder="Untitled project"
        spellcheck="false"
        autocomplete="off"
      />

      <div class="progress-track" aria-hidden="true">
        <span class="progress-fill" style="width:${percent}%"></span>
      </div>

      <div class="todo-list" data-project-id="${escapeHtml(project.id)}">
        ${todoMarkup}
      </div>

      <div class="add-row">
        ${ICONS.plus}
        <input
          class="add-todo"
          type="text"
          data-project-id="${escapeHtml(project.id)}"
          placeholder="Add a next action…"
          aria-label="Add a next action to ${escapeHtml(project.title || "Untitled project")}"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
    </article>`;
}

function renderTodo(project, todo) {
  const info = dueInfo(todo.due);
  return `
    <div class="todo-row ${todo.completed ? "is-done" : ""}">
      <button
        class="check"
        type="button"
        data-action="toggle-todo"
        data-project-id="${escapeHtml(project.id)}"
        data-todo-id="${escapeHtml(todo.id)}"
        aria-label="${todo.completed ? "Mark as open" : "Mark as done"}: ${escapeHtml(todo.title || "Untitled task")}"
      >${ICONS.check}</button>

      <textarea
        class="todo-title"
        rows="1"
        wrap="soft"
        data-project-id="${escapeHtml(project.id)}"
        data-todo-id="${escapeHtml(todo.id)}"
        aria-label="Task name"
        placeholder="Untitled task"
        spellcheck="false"
        autocomplete="off"
      >${escapeHtml(todo.title)}</textarea>

      <button
        class="delete-todo"
        type="button"
        data-action="delete-todo"
        data-project-id="${escapeHtml(project.id)}"
        data-todo-id="${escapeHtml(todo.id)}"
        aria-label="Delete task"
      >${ICONS.close}</button>

      <button
        class="due-chip ${info.className}"
        type="button"
        data-action="pick-date"
        data-project-id="${escapeHtml(project.id)}"
        data-todo-id="${escapeHtml(todo.id)}"
        data-popover-anchor
        title="${escapeHtml(info.title)}"
        aria-label="Due date: ${escapeHtml(info.title)}"
      >${ICONS.calendar}<span>${escapeHtml(info.label)}</span></button>
    </div>`;
}

function resizeTodoTitle(element) {
  if (!(element instanceof HTMLTextAreaElement)) return;
  element.style.height = "auto";
  element.style.height = `${Math.max(22, element.scrollHeight)}px`;
}

function resizeTodoTitles() {
  for (const element of dom.grid.querySelectorAll(".todo-title")) {
    resizeTodoTitle(element);
  }
}

function applyPendingFocus() {
  if (!pendingFocus) return;
  const request = pendingFocus;
  pendingFocus = null;

  requestAnimationFrame(() => {
    let element = null;
    if (request.kind === "project-title") {
      element = dom.grid.querySelector(
        `.project-title[data-project-id="${cssEscape(request.projectId)}"]`,
      );
    } else if (request.kind === "add-todo") {
      element = dom.grid.querySelector(
        `.add-todo[data-project-id="${cssEscape(request.projectId)}"]`,
      );
    } else if (request.kind === "todo-title") {
      element = dom.grid.querySelector(
        `.todo-title[data-todo-id="${cssEscape(request.todoId)}"]`,
      );
    }

    if (!element) return;
    element.focus({ preventScroll: true });
    if (request.selectAll) element.select();
  });
}

/* -------------------------------------------------------------------------- */
/* Project + task actions                                                     */
/* -------------------------------------------------------------------------- */

function addProject() {
  closePopover();
  const project = {
    id: uid(),
    title: "Untitled project",
    color: PALETTE[state.projects.length % PALETTE.length],
    todos: [],
  };

  state.projects.push(project);
  pendingFocus = { kind: "project-title", projectId: project.id, selectAll: true };
  markChanged();
  renderAll();
  requestAnimationFrame(() => {
    dom.grid.scrollTop = dom.grid.scrollHeight;
  });
}

function addTodo(projectId, title) {
  const project = findProject(projectId);
  if (!project) return;

  const cleanTitle = title.trim();
  if (!cleanTitle) return;

  project.todos.push({
    id: uid(),
    title: cleanTitle,
    due: null,
    completed: false,
  });

  pendingFocus = { kind: "add-todo", projectId };
  markChanged();
  renderAll();
}

function toggleTodo(projectId, todoId) {
  const { todo } = findTodo(projectId, todoId);
  if (!todo) return;

  todo.completed = !todo.completed;
  markChanged();
  renderAll();
}

function deleteTodo(projectId, todoId) {
  const { project, todo, index } = findTodo(projectId, todoId);
  if (!project || !todo) return;

  project.todos.splice(index, 1);
  markChanged();
  renderAll();
  void saveNow();

  const title = todo.title.trim() || "Task";
  showToast(`“${title}” deleted`, () => {
    const currentProject = findProject(projectId);
    if (!currentProject) return;
    currentProject.todos.splice(Math.min(index, currentProject.todos.length), 0, todo);
    markChanged();
    renderAll();
  });
}

function deleteProject(projectId) {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index < 0) return;

  const [removed] = state.projects.splice(index, 1);
  closePopover();
  markChanged();
  renderAll();
  void saveNow();

  showToast(`“${removed.title.trim() || "Untitled project"}” deleted`, () => {
    state.projects.splice(Math.min(index, state.projects.length), 0, removed);
    markChanged();
    renderAll();
  });
}

function clearCompleted(projectId) {
  const project = findProject(projectId);
  if (!project) return;

  const completed = project.todos.filter((todo) => todo.completed);
  if (completed.length === 0) return;

  const before = project.todos;
  project.todos = project.todos.filter((todo) => !todo.completed);
  closePopover();
  markChanged();
  renderAll();
  void saveNow();

  showToast(`Cleared ${plural(completed.length, "completed task")}`, () => {
    const currentProject = findProject(projectId);
    if (!currentProject) return;
    currentProject.todos = before;
    markChanged();
    renderAll();
  });
}

function setTodoDue(projectId, todoId, due) {
  const { todo } = findTodo(projectId, todoId);
  if (!todo) return;

  todo.due = due;
  closePopover();
  markChanged();
  renderAll();
  void saveNow();
}

/* -------------------------------------------------------------------------- */
/* Popovers                                                                   */
/* -------------------------------------------------------------------------- */

function closePopover() {
  activePopover = null;
  dom.popoverLayer.replaceChildren();
}

function positionPopover(element, anchor, width, alignment = "right") {
  if (!anchor || !anchor.isConnected) {
    element.style.left = "50%";
    element.style.top = "50%";
    return;
  }

  element.style.width = `${width}px`;
  const anchorRect = anchor.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const margin = 16;
  const gap = 7;

  let top = anchorRect.bottom + gap;
  if (top + rect.height > window.innerHeight - margin) {
    top = anchorRect.top - rect.height - gap;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin));

  let left;
  if (alignment === "right") {
    left = anchorRect.right - rect.width;
  } else {
    left = anchorRect.left;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));

  element.style.top = `${Math.round(top)}px`;
  element.style.left = `${Math.round(left)}px`;
}

function openProjectMenu(projectId, anchor) {
  closePopover();
  const project = findProject(projectId);
  if (!project) return;

  activePopover = { type: "project-menu", projectId, anchor };
  const completedCount = project.todos.filter((todo) => todo.completed).length;

  const element = document.createElement("div");
  element.className = "popover project-menu";
  element.innerHTML = `
    <p class="menu-label">Card color</p>
    <div class="swatches">
      ${PALETTE.map(
        (color) => `
          <button
            class="swatch ${color === project.color ? "is-active" : ""}"
            type="button"
            style="--swatch:${color}"
            data-menu-color="${color}"
            aria-label="Use ${color}"
          ></button>`,
      ).join("")}
    </div>
    <div class="menu-sep"></div>
    ${
      completedCount > 0
        ? `<button class="menu-item" type="button" data-menu-action="clear-completed">
             Clear completed <span>${completedCount}</span>
           </button>`
        : ""
    }
    <button class="menu-item danger" type="button" data-menu-action="delete-project">
      Delete project
    </button>`;

  dom.popoverLayer.replaceChildren(element);
  positionPopover(element, anchor, 232, "right");
}

function openDatePicker(projectId, todoId, anchor) {
  closePopover();
  const { todo } = findTodo(projectId, todoId);
  if (!todo) return;

  activePopover = {
    type: "date",
    projectId,
    todoId,
    anchor,
    selected: todo.due,
  };
  calendarCursor = todo.due ? fromKey(todo.due) : new Date();
  renderDatePopover();
}

function renderDatePopover() {
  if (!activePopover || activePopover.type !== "date") return;

  const { anchor, selected } = activePopover;
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1, 12);
  const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = addDays(firstOfMonth, -mondayOffset);
  const today = todayKey();

  const days = [];
  for (let index = 0; index < 42; index += 1) {
    const date = addDays(gridStart, index);
    const key = toKey(date);
    const classes = ["day"];
    if (date.getMonth() !== month) classes.push("is-outside");
    if (key === today) classes.push("is-today");
    if (key === selected) classes.push("is-selected");

    days.push(`
      <button class="${classes.join(" ")}" type="button" data-calendar-date="${key}" aria-label="${escapeHtml(fullDate(key))}">
        ${date.getDate()}
      </button>`);
  }

  const element = document.createElement("div");
  element.className = "popover date-popover";
  element.innerHTML = `
    <div class="calendar-head">
      <span class="calendar-title">${escapeHtml(monthLabel(calendarCursor))}</span>
      <div class="calendar-nav">
        <button type="button" data-calendar-nav="-1" aria-label="Previous month">${ICONS.chevronLeft}</button>
        <button type="button" data-calendar-nav="1" aria-label="Next month">${ICONS.chevronRight}</button>
      </div>
    </div>
    <div class="calendar-weekdays" aria-hidden="true">
      ${WEEK_LABELS.map((label) => `<span>${label}</span>`).join("")}
    </div>
    <div class="calendar-days">${days.join("")}</div>
    <div class="calendar-quick">
      <button class="quick-btn" type="button" data-calendar-quick="today">Today</button>
      <button class="quick-btn" type="button" data-calendar-quick="tomorrow">Tomorrow</button>
      <button class="quick-btn is-danger" type="button" data-calendar-quick="clear" ${selected ? "" : "disabled"}>Clear</button>
    </div>`;

  dom.popoverLayer.replaceChildren(element);
  positionPopover(element, anchor, 264, "right");
}

function handlePopoverClick(event) {
  const nav = event.target.closest("[data-calendar-nav]");
  if (nav && activePopover?.type === "date") {
    calendarCursor = new Date(
      calendarCursor.getFullYear(),
      calendarCursor.getMonth() + Number(nav.dataset.calendarNav),
      1,
      12,
    );
    renderDatePopover();
    return;
  }

  const dateButton = event.target.closest("[data-calendar-date]");
  if (dateButton && activePopover?.type === "date") {
    setTodoDue(activePopover.projectId, activePopover.todoId, dateButton.dataset.calendarDate);
    return;
  }

  const quick = event.target.closest("[data-calendar-quick]");
  if (quick && activePopover?.type === "date") {
    const { projectId, todoId } = activePopover;
    if (quick.dataset.calendarQuick === "today") {
      setTodoDue(projectId, todoId, todayKey());
    } else if (quick.dataset.calendarQuick === "tomorrow") {
      setTodoDue(projectId, todoId, toKey(addDays(new Date(), 1)));
    } else {
      setTodoDue(projectId, todoId, null);
    }
    return;
  }

  const colorButton = event.target.closest("[data-menu-color]");
  if (colorButton && activePopover?.type === "project-menu") {
    const project = findProject(activePopover.projectId);
    if (!project) return;
    project.color = colorButton.dataset.menuColor;
    closePopover();
    markChanged();
    renderAll();
    return;
  }

  const menuAction = event.target.closest("[data-menu-action]");
  if (menuAction && activePopover?.type === "project-menu") {
    const projectId = activePopover.projectId;
    if (menuAction.dataset.menuAction === "delete-project") {
      deleteProject(projectId);
    } else if (menuAction.dataset.menuAction === "clear-completed") {
      clearCompleted(projectId);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Toast                                                                      */
/* -------------------------------------------------------------------------- */

function hideToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastUndo = null;
  dom.toast.classList.remove("is-visible");
}

function showToast(message, undo = null) {
  if (toastTimer) clearTimeout(toastTimer);
  toastUndo = undo;
  dom.toastMessage.textContent = message;
  dom.toastAction.classList.toggle("is-hidden", !undo);
  dom.toast.classList.add("is-visible");

  toastTimer = setTimeout(() => {
    dom.toast.classList.remove("is-visible");
    toastUndo = null;
    toastTimer = null;
  }, 5000);
}

/* -------------------------------------------------------------------------- */
/* Overlay lifecycle                                                          */
/* -------------------------------------------------------------------------- */

function replayIntro() {
  document.body.classList.remove("is-entering");
  void document.body.offsetWidth;
  document.body.classList.add("is-entering");
  setTimeout(() => document.body.classList.remove("is-entering"), 320);
}

function updateToday() {
  dom.todayLabel.textContent = longDate();
  const nextDayKey = todayKey();
  if (nextDayKey !== currentDayKey) {
    currentDayKey = nextDayKey;
    renderAll();
  }
}

async function hideOverlay() {
  if (hiding) return;
  hiding = true;
  closePopover();
  hideToast();
  await flushSave();
  document.body.classList.add("is-closing");

  setTimeout(async () => {
    try {
      if (TAURI?.core?.invoke) {
        await TAURI.core.invoke("hide_overlay");
      }
    } catch (error) {
      console.error("ProjectTray could not hide the overlay.", error);
    } finally {
      document.body.classList.remove("is-closing");
      hiding = false;
    }
  }, 95);
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function handleGridClick(event) {
  const actionElement = event.target.closest("[data-action]");
  if (!actionElement) return;

  const { action, projectId, todoId } = actionElement.dataset;

  if (action === "toggle-todo") {
    toggleTodo(projectId, todoId);
  } else if (action === "delete-todo") {
    deleteTodo(projectId, todoId);
  } else if (action === "pick-date") {
    openDatePicker(projectId, todoId, actionElement);
  } else if (action === "project-menu") {
    openProjectMenu(projectId, actionElement);
  }
}

function handleGridInput(event) {
  const element = event.target;

  if (element instanceof HTMLTextAreaElement && element.classList.contains("todo-title")) {
    const { todo } = findTodo(element.dataset.projectId, element.dataset.todoId);
    if (!todo) return;
    todo.title = element.value;
    resizeTodoTitle(element);
    markChanged();
    return;
  }

  if (!(element instanceof HTMLInputElement)) return;

  if (element.classList.contains("project-title")) {
    const project = findProject(element.dataset.projectId);
    if (!project) return;
    project.title = element.value;
    markChanged();
  }
}

function handleGridKeydown(event) {
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;

  if (event.key === "Enter") {
    if (element.classList.contains("add-todo")) {
      event.preventDefault();
      addTodo(element.dataset.projectId, element.value);
      return;
    }

    if (
      element.classList.contains("project-title") ||
      element.classList.contains("todo-title")
    ) {
      event.preventDefault();
      element.blur();
    }
  }
}

function handleGridFocusOut(event) {
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;

  if (element.classList.contains("project-title") && !element.value.trim()) {
    element.value = "Untitled project";
    const project = findProject(element.dataset.projectId);
    if (project) project.title = "Untitled project";
    markChanged();
    return;
  }

  if (element.classList.contains("todo-title")) {
    if (!element.value.trim()) {
      element.value = "Untitled task";
      const { todo } = findTodo(element.dataset.projectId, element.dataset.todoId);
      if (todo) todo.title = "Untitled task";
      markChanged();
    }
    resizeTodoTitle(element);
  }
}

function handleDocumentClick(event) {
  const newProject = event.target.closest('[data-action="new-project"]');
  if (newProject) {
    addProject();
    return;
  }

  const close = event.target.closest('[data-action="close"]');
  if (close) {
    void hideOverlay();
    return;
  }

  if (!activePopover) return;
  if (event.target.closest(".popover") || event.target.closest("[data-popover-anchor]")) {
    return;
  }
  closePopover();
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    if (activePopover) {
      closePopover();
    } else {
      void hideOverlay();
    }
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    addProject();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
    event.preventDefault();
    void hideOverlay();
  }
}

function bindEvents() {
  dom.grid.addEventListener("click", handleGridClick);
  dom.grid.addEventListener("input", handleGridInput);
  dom.grid.addEventListener("keydown", handleGridKeydown);
  dom.grid.addEventListener("focusout", handleGridFocusOut);
  dom.grid.addEventListener(
    "scroll",
    () => {
      if (activePopover) closePopover();
    },
    true,
  );

  dom.popoverLayer.addEventListener("click", handlePopoverClick);
  dom.themeToggle.addEventListener("click", toggleTheme);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleKeydown);

  dom.backdrop.addEventListener("click", (event) => {
    if (event.target !== dom.backdrop) return;
    if (activePopover) {
      closePopover();
      return;
    }
    void hideOverlay();
  });

  dom.toastAction.addEventListener("click", () => {
    const undo = toastUndo;
    hideToast();
    if (undo) undo();
  });

  window.addEventListener("focus", updateToday);
  window.addEventListener("resize", () => {
    if (activePopover) closePopover();
    resizeTodoTitles();
  });

  if (TAURI?.event?.listen) {
    void TAURI.event.listen("overlay-shown", () => {
      updateToday();
      replayIntro();
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function init() {
  bindEvents();
  updateToday();
  await loadInitialState();
  await applyTheme(state.theme, { persist: false });
  renderAll();
}

void init();
