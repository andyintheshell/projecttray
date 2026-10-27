import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, message, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await condition();
    if (value) return value;
    await sleep(75);
  }
  throw new Error(`Timed out: ${message}`);
}

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(srcDir, relativePath);

    if (!filePath.startsWith(`${srcDir}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, contents) => {
      if (error) {
        response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(contents);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function startChrome(executable, url) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "projecttray-ui-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-sync",
      "--hide-scrollbars",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const portFile = path.join(profile, "DevToolsActivePort");
  const port = await waitFor(
    () => {
      if (!fs.existsSync(portFile)) return false;
      return Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
    },
    "Chrome DevTools port",
    20000,
  ).catch((error) => {
    child.kill("SIGKILL");
    throw new Error(`${error.message}\n${stderr}`);
  });

  const targets = await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await response.json();
        const page = list.find((target) => target.type === "page" && target.url.startsWith(url));
        return page ? { list, page } : false;
      } catch {
        return false;
      }
    },
    "Chrome page target",
  ).catch((error) => {
    child.kill("SIGKILL");
    throw new Error(`${error.message}\n${stderr}`);
  });

  return { child, profile, page: targets.page };
}

function connectCdp(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const errors = [];
  let nextId = 1;

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      errors.push(`${details.text}: ${details.exception?.description ?? ""}`);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(
        `console.error: ${message.params.args.map((arg) => arg.value ?? arg.description).join(" ")}`,
      );
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description ?? ""}`,
      );
    }
    return result.result.value;
  }

  return {
    ws,
    errors,
    send,
    evaluate,
    ready: new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    }),
  };
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function appReady(evaluate) {
  try {
    return await evaluate(
      `document.readyState === "complete" && Boolean(document.querySelector(".project-card, .empty-state"))`,
    );
  } catch {
    return false;
  }
}

let server;
let chrome;
let cdp;

try {
  const executable = findChrome();
  if (!executable) {
    throw new Error("Chrome not found. Set CHROME_PATH to a Chromium-based browser.");
  }

  const staticServer = await startStaticServer();
  server = staticServer.server;
  const startedChrome = await startChrome(executable, staticServer.url);
  chrome = startedChrome.child;
  cdp = connectCdp(startedChrome.page);
  await cdp.ready;

  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.evaluate("localStorage.clear()");
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => appReady(cdp.evaluate), "app boot");

  const snapshot = () =>
    cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.project-card')];
      return {
        cards: cards.length,
        titles: cards.map((card) => card.querySelector('.project-title').value),
        todos: cards.map((card) => card.querySelectorAll('.todo-row').length),
        open: document.getElementById('open-count').textContent,
        due: document.getElementById('due-count').textContent,
        summary: document.getElementById('project-summary').textContent,
        empty: Boolean(document.querySelector('.empty-state')),
      };
    })()`);

  let state = await snapshot();
  check("seed renders four projects", state.cards === 4, JSON.stringify(state));
  check(
    "seed has 14 tasks",
    state.todos.reduce((total, count) => total + count, 0) === 14,
    JSON.stringify(state.todos),
  );
  check("summary counts projects", state.summary === "4 projects", state.summary);
  check("open counter excludes completed", state.open === "11", state.open);
  check("due counter includes overdue + due soon", state.due === "4", state.due);

  // Task row layout regressions
  const layout = await cdp.evaluate(`(() => {
    const card = document.querySelector('.project-card');
    const row = card.querySelector('.todo-row');
    const title = row.querySelector('.todo-title');
    const chip = row.querySelector('.due-chip');
    const check = row.querySelector('.check');
    const cardRect = card.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    const checkRect = check.getBoundingClientRect();
    return {
      tag: title.tagName,
      rows: title.rows,
      wrap: title.wrap,
      cardWidth: cardRect.width,
      titleWidth: titleRect.width,
      chipRightGap: cardRect.right - chipRect.right,
      checkCenterOffset: Math.abs(
        (checkRect.top + checkRect.bottom) / 2 - (rowRect.top + rowRect.bottom) / 2,
      ),
      rowHeight: rowRect.height,
    };
  })()`);
  check(
    "task titles use wrapping textareas",
    layout.tag === "TEXTAREA" && layout.rows === 1 && layout.wrap === "soft",
    JSON.stringify(layout),
  );
  check(
    "due date chip sits near card right edge",
    layout.chipRightGap <= 20,
    `${layout.chipRightGap}px`,
  );
  check(
    "task title uses expanded card width",
    layout.titleWidth > 180 && layout.titleWidth / layout.cardWidth > 0.55,
    `${layout.titleWidth}px of ${layout.cardWidth}px`,
  );
  check(
    "checkmark is vertically centered",
    layout.checkCenterOffset <= 1.5,
    `${layout.checkCenterOffset}px`,
  );

  const longTitle = "Prepare the detailed relocation checklist for the Madrid apartment";
  await cdp.evaluate(`(() => {
    const title = document.querySelector('.project-card .todo-row .todo-title');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(title, ${JSON.stringify(longTitle)});
    title.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);

  const wrapped = await cdp.evaluate(`(() => {
    const row = document.querySelector('.project-card .todo-row');
    const title = row.querySelector('.todo-title');
    const check = row.querySelector('.check');
    const rowRect = row.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const checkRect = check.getBoundingClientRect();
    return {
      value: title.value,
      titleHeight: titleRect.height,
      rowHeight: rowRect.height,
      scrollHeight: title.scrollHeight,
      clientHeight: title.clientHeight,
      scrollWidth: title.scrollWidth,
      clientWidth: title.clientWidth,
      checkCenterOffset: Math.abs(
        (checkRect.top + checkRect.bottom) / 2 - (rowRect.top + rowRect.bottom) / 2,
      ),
    };
  })()`);
  check("long task titles keep their full value", wrapped.value === longTitle, wrapped.value);
  check(
    "long task titles wrap and grow the row",
    wrapped.titleHeight > 30 && wrapped.rowHeight > 34,
    JSON.stringify(wrapped),
  );
  check(
    "wrapped task titles do not scroll internally",
    wrapped.scrollHeight <= wrapped.clientHeight + 1 &&
      wrapped.scrollWidth <= wrapped.clientWidth + 1,
    JSON.stringify(wrapped),
  );
  check(
    "checkmark stays centered on a wrapped row",
    wrapped.checkCenterOffset <= 1.5,
    `${wrapped.checkCenterOffset}px`,
  );

  // Reset the seed after mutating a title.
  await cdp.evaluate("localStorage.clear()");
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => appReady(cdp.evaluate), "app reload");

  // Theme toggle + light mode
  const initialTheme = await cdp.evaluate(`(() => ({
    theme: document.documentElement.dataset.theme,
    label: document.getElementById('theme-toggle').getAttribute('aria-label'),
    sun: getComputedStyle(document.querySelector('.theme-btn .sun-icon')).display,
    moon: getComputedStyle(document.querySelector('.theme-btn .moon-icon')).display,
  }))()`);
  check(
    "dark theme is active on launch",
    initialTheme.theme === "dark" &&
      initialTheme.label === "Switch to light mode" &&
      initialTheme.sun !== "none" &&
      initialTheme.moon === "none",
    JSON.stringify(initialTheme),
  );

  await cdp.evaluate(`document.getElementById('theme-toggle').click()`);
  await sleep(900);
  const lightTheme = await cdp.evaluate(`(() => {
    const styles = getComputedStyle(document.documentElement);
    const stored = JSON.parse(localStorage.getItem('projecttray.state.v1'));
    return {
      theme: document.documentElement.dataset.theme,
      label: document.getElementById('theme-toggle').getAttribute('aria-label'),
      text: styles.getPropertyValue('--text').trim(),
      stored: stored?.theme,
      sun: getComputedStyle(document.querySelector('.theme-btn .sun-icon')).display,
      moon: getComputedStyle(document.querySelector('.theme-btn .moon-icon')).display,
    };
  })()`);
  check(
    "theme toggle switches to light and persists",
    lightTheme.theme === "light" &&
      lightTheme.label === "Switch to dark mode" &&
      lightTheme.text === "#1d1f26" &&
      lightTheme.stored === "light" &&
      lightTheme.sun === "none" &&
      lightTheme.moon !== "none",
    JSON.stringify(lightTheme),
  );

  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => appReady(cdp.evaluate), "theme reload");
  const reloadedTheme = await cdp.evaluate(`(() => ({
    theme: document.documentElement.dataset.theme,
    label: document.getElementById('theme-toggle').getAttribute('aria-label'),
  }))()`);
  check(
    "light theme survives reload",
    reloadedTheme.theme === "light" && reloadedTheme.label === "Switch to dark mode",
    JSON.stringify(reloadedTheme),
  );

  // New project
  await cdp.evaluate(`document.querySelector('[data-action="new-project"]').click()`);
  await sleep(100);
  state = await snapshot();
  check("new project card added", state.cards === 5, JSON.stringify(state));

  const focusInfo = await cdp.evaluate(`(() => {
    const element = document.activeElement;
    return {
      cls: element?.className,
      selected: element?.selectionStart === 0 && element?.selectionEnd === element?.value.length,
    };
  })()`);
  check(
    "new project title focused and selected",
    focusInfo.cls?.includes("project-title") && focusInfo.selected,
    JSON.stringify(focusInfo),
  );

  const projectId = await cdp.evaluate(
    `document.querySelectorAll('.project-card')[4].dataset.projectCard`,
  );
  await cdp.evaluate(`(() => {
    const element = document.querySelector('.project-title[data-project-id="${projectId}"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(element, 'Launch checklist');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(50);

  // Add tasks
  for (const title of ["Draft announcement", "Record demo"]) {
    await cdp.evaluate(`(() => {
      const element = document.querySelector('.add-todo[data-project-id="${projectId}"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(element, ${JSON.stringify(title)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(100);
  }
  state = await snapshot();
  check("two tasks added to new project", state.todos[4] === 2, JSON.stringify(state.todos));

  // Textarea Enter commits without inserting a newline.
  const enterCommit = await cdp.evaluate(`(() => {
    const title = document.querySelector('.project-card[data-project-card="${projectId}"] .todo-title');
    title.focus();
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return {
      focused: document.activeElement === title,
      value: title.value,
      hasNewline: title.value.includes('\\n'),
    };
  })()`);
  check(
    "Enter blurs task titles without adding a newline",
    !enterCommit.focused && !enterCommit.hasNewline,
    JSON.stringify(enterCommit),
  );

  // Empty task titles get a fallback on blur.
  const fallbackTitle = await cdp.evaluate(`(() => {
    const title = document.querySelector('.project-card[data-project-card="${projectId}"] .todo-title');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    title.focus();
    setter.call(title, '   ');
    title.dispatchEvent(new Event('input', { bubbles: true }));
    title.blur();
    return title.value;
  })()`);
  await sleep(50);
  check("empty task titles fall back to Untitled task", fallbackTitle === "Untitled task", fallbackTitle);

  // Toggle first task done
  await cdp.evaluate(
    `document.querySelector('.project-card[data-project-card="${projectId}"] .check').click()`,
  );
  await sleep(80);
  const doneState = await cdp.evaluate(`(() => {
    const card = document.querySelector('.project-card[data-project-card="${projectId}"]');
    return {
      done: card.querySelectorAll('.todo-row.is-done').length,
      count: card.querySelector('.project-count').textContent,
    };
  })()`);
  check(
    "task toggles complete",
    doneState.done === 1 && doneState.count === "1 / 2 done",
    JSON.stringify(doneState),
  );

  // Date picker
  await cdp.evaluate(
    `document.querySelector('.project-card[data-project-card="${projectId}"] .due-chip').click()`,
  );
  await sleep(80);
  const picker = await cdp.evaluate(`(() => ({
    visible: Boolean(document.querySelector('.date-popover')),
    title: document.querySelector('.calendar-title')?.textContent,
    days: document.querySelectorAll('[data-calendar-date]').length,
    quick: document.querySelectorAll('[data-calendar-quick]').length,
  }))()`);
  check(
    "date picker opens with 42 days and quick actions",
    picker.visible && picker.days === 42 && picker.quick === 3,
    JSON.stringify(picker),
  );
  await cdp.evaluate(`document.querySelector('[data-calendar-quick="tomorrow"]').click()`);
  await sleep(120);
  const tomorrow = await cdp.evaluate(`(() => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    const key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    const chip = document.querySelector('.project-card[data-project-card="${projectId}"] .due-chip');
    return {
      key,
      label: chip.textContent.trim(),
      pickerClosed: !document.querySelector('.date-popover'),
    };
  })()`);
  check(
    "date quick-action sets Tomorrow and closes",
    tomorrow.label === "Tomorrow" && tomorrow.pickerClosed,
    JSON.stringify(tomorrow),
  );

  // Project menu + color
  await cdp.evaluate(
    `document.querySelector('.project-card[data-project-card="${projectId}"] .project-menu-btn').click()`,
  );
  await sleep(80);
  const menu = await cdp.evaluate(`(() => ({
    visible: Boolean(document.querySelector('.project-menu')),
    swatches: document.querySelectorAll('[data-menu-color]').length,
    clear: Boolean(document.querySelector('[data-menu-action="clear-completed"]')),
  }))()`);
  check(
    "project menu shows palette and clear action",
    menu.visible && menu.swatches === 8 && menu.clear,
    JSON.stringify(menu),
  );
  const newColor = await cdp.evaluate(
    `document.querySelector('[data-menu-color="#c6a7ff"]').click(); document.querySelector('.project-card[data-project-card="${projectId}"]').style.getPropertyValue('--accent')`,
  );
  check("color swatch updates card accent", newColor === "#c6a7ff", newColor);

  // Delete + undo task
  await cdp.evaluate(`(() => {
    const card = document.querySelector('.project-card[data-project-card="${projectId}"]');
    card.querySelectorAll('.todo-row')[0].querySelector('.delete-todo').click();
  })()`);
  await sleep(100);
  let afterDelete = await snapshot();
  const toast = await cdp.evaluate(`(() => ({
    visible: document.getElementById('toast').classList.contains('is-visible'),
    message: document.getElementById('toast-message').textContent,
    undoVisible: !document.getElementById('toast-action').classList.contains('is-hidden'),
  }))()`);
  check(
    "deleting task shows undo toast",
    afterDelete.todos[4] === 1 && toast.visible && toast.undoVisible,
    JSON.stringify({ count: afterDelete.todos[4], toast }),
  );
  await cdp.evaluate(`document.getElementById('toast-action').click()`);
  await sleep(100);
  afterDelete = await snapshot();
  check("undo restores deleted task", afterDelete.todos[4] === 2, JSON.stringify(afterDelete.todos));

  // Persistence
  await sleep(700);
  const stored = await cdp.evaluate(`JSON.parse(localStorage.getItem('projecttray.state.v1'))`);
  check(
    "state persisted with renamed project",
    stored.projects[4]?.title === "Launch checklist",
    JSON.stringify(stored.projects[4]?.title),
  );
  check("state persisted color", stored.projects[4]?.color === "#c6a7ff", stored.projects[4]?.color);
  check(
    "state persisted completed task",
    stored.projects[4]?.todos.filter((todo) => todo.completed).length === 1,
    JSON.stringify(stored.projects[4]?.todos),
  );
  check(
    "state persisted tomorrow due date",
    stored.projects[4]?.todos.some((todo) => todo.due === tomorrow.key),
    JSON.stringify(stored.projects[4]?.todos.map((todo) => todo.due)),
  );
  check("state persisted light theme", stored.theme === "light", String(stored.theme));

  // Reload and verify persistence
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => appReady(cdp.evaluate), "persistence reload");
  state = await snapshot();
  check("reload keeps five projects", state.cards === 5, JSON.stringify(state));
  check("reload keeps edited title", state.titles[4] === "Launch checklist", JSON.stringify(state.titles));
  const reloadAccent = await cdp.evaluate(
    `document.querySelectorAll('.project-card')[4].style.getPropertyValue('--accent')`,
  );
  check("reload keeps card color", reloadAccent === "#c6a7ff", reloadAccent);

  // Delete project + undo
  await cdp.evaluate(
    `document.querySelectorAll('.project-card')[4].querySelector('.project-menu-btn').click()`,
  );
  await sleep(60);
  await cdp.evaluate(`document.querySelector('[data-menu-action="delete-project"]').click()`);
  await sleep(120);
  state = await snapshot();
  check("delete project removes card", state.cards === 4, JSON.stringify(state));
  await cdp.evaluate(`document.getElementById('toast-action').click()`);
  await sleep(100);
  state = await snapshot();
  check(
    "undo restores project",
    state.cards === 5 && state.titles[4] === "Launch checklist",
    JSON.stringify(state),
  );

  // Empty state by deleting all projects one at a time (no undo)
  for (let index = 0; index < 5; index += 1) {
    await cdp.evaluate(`document.querySelector('.project-card .project-menu-btn').click()`);
    await sleep(50);
    await cdp.evaluate(`document.querySelector('[data-menu-action="delete-project"]').click()`);
    await sleep(80);
  }
  state = await snapshot();
  check("empty state appears after deleting all projects", state.empty && state.cards === 0, JSON.stringify(state));
  await cdp.evaluate(`document.querySelector('[data-action="new-project"]').click()`);
  await sleep(100);
  state = await snapshot();
  check("empty state new-project button works", state.cards === 1, JSON.stringify(state));

  // Restore seed and verify the theme returns to the system default.
  await cdp.evaluate("localStorage.clear()");
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => appReady(cdp.evaluate), "final reload");
  const restoredTheme = await cdp.evaluate(`document.documentElement.dataset.theme`);
  check("fresh state returns to the system dark theme", restoredTheme === "dark", restoredTheme);

  check("no console errors or exceptions", cdp.errors.length === 0, cdp.errors.join(" | "));
} catch (error) {
  failures += 1;
  console.error(`\nERROR  ${error.stack ?? error}`);
} finally {
  try {
    cdp?.ws.close();
  } catch {}
  try {
    chrome?.kill("SIGKILL");
  } catch {}
  try {
    server?.close();
  } catch {}
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
