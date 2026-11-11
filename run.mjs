#!/usr/bin/env node
// run.mjs — obico-prusalink-bridge task runner
// Usage: ./run.mjs [task]  or  ./run.mjs (interactive picker)

import { spawn } from "child_process";
import { createInterface } from "readline";

// ── ANSI helpers ────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
};
const bold = (s) => `${c.bold}${s}${c.reset}`;
const dim = (s) => `${c.dim}${s}${c.reset}`;
const cyan = (s) => `${c.cyan}${s}${c.reset}`;
const green = (s) => `${c.green}${s}${c.reset}`;
const yellow = (s) => `${c.yellow}${s}${c.reset}`;
const red = (s) => `${c.red}${s}${c.reset}`;

// ── Task definitions ─────────────────────────────────────────────────────────
const groups = [
  {
    name: "Dev",
    tasks: [
      {
        key: "dev",
        desc: "Backend + Frontend (watch mode + Vite proxy)",
        cmd: "npm run dev:all",
      },
      {
        key: "dev:back",
        desc: "Backend only (tsx watch)",
        cmd: "npm run dev:backend",
      },
      {
        key: "dev:front",
        desc: "Frontend only (Vite + proxy)",
        cmd: "npm run dev:frontend:proxy",
      },
    ],
  },
  {
    name: "Test",
    tasks: [
      { key: "test", desc: "Run all tests", cmd: "npm run test:backend" },
      {
        key: "test:watch",
        desc: "Watch mode",
        cmd: "npm run test:backend -- --watch",
      },
      {
        key: "typecheck",
        desc: "Type-check without emitting (tsc --noEmit)",
        cmd: "npm run typecheck",
      },
      {
        key: "format",
        desc: "Format all files with Prettier",
        cmd: "npx prettier --write .",
      },
    ],
  },
  {
    name: "Build",
    tasks: [
      {
        key: "build",
        desc: "Compile TypeScript + Vite (production)",
        cmd: "npm run build:all",
      },
      {
        key: "build:back",
        desc: "Backend only (tsc)",
        cmd: "npm run build:backend",
      },
      {
        key: "build:front",
        desc: "Frontend only (Vite)",
        cmd: "npm run build:frontend",
      },
    ],
  },
  {
    name: "Docker",
    tasks: [
      {
        key: "docker:dev",
        desc: "Build image + run with ./config mounted",
        cmd: "npm run docker:dev",
      },
      {
        key: "docker:run",
        desc: "Run already-built image (no rebuild)",
        cmd: "npm run docker:run",
      },
      {
        key: "docker:logs",
        desc: "Follow logs of running bridge container",
        cmd: "npm run docker:logs",
      },
      {
        key: "docker:build",
        desc: "Build image (single platform)",
        cmd: "npm run build:docker",
      },
      {
        key: "docker:build:multi",
        desc: "Build multi-platform (amd64 + arm64)",
        cmd: "npm run build:docker:multiplatform",
      },
      {
        key: "docker:clean",
        desc: "Stop all containers + remove local image",
        cmd: "npm run docker:clean",
      },
    ],
  },
  {
    name: "Janus",
    tasks: [
      {
        key: "janus:up",
        desc: "Start Janus WebRTC sidecar (Docker, Mac dev only)",
        cmd: "docker compose -f docker-compose.dev.yml up -d",
      },
      {
        key: "janus:down",
        desc: "Stop Janus WebRTC sidecar",
        cmd: "docker compose -f docker-compose.dev.yml down",
      },
      {
        key: "janus:logs",
        desc: "Follow Janus sidecar logs",
        cmd: "docker compose -f docker-compose.dev.yml logs -f janus",
      },
    ],
  },
  {
    name: "Clean",
    tasks: [
      {
        key: "clean",
        desc: "Remove all build artifacts (dist/, frontend/dist/, reports/)",
        cmd: "rm -rf dist frontend/dist reports",
      },
      {
        key: "clean:back",
        desc: "Remove backend build (dist/)",
        cmd: "rm -rf dist",
      },
      {
        key: "clean:front",
        desc: "Remove frontend build (frontend/dist/)",
        cmd: "rm -rf frontend/dist",
      },
    ],
  },
  {
    name: "Setup",
    tasks: [
      {
        key: "install",
        desc: "Install all dependencies (root + frontend)",
        cmd: "npm run install:all",
      },
    ],
  },
];

// ── Flat task lookup ──────────────────────────────────────────────────────────
const allTasks = groups.flatMap((g) => g.tasks);
const byKey = Object.fromEntries(allTasks.map((t) => [t.key, t]));

// ── Janus sidecar check (for docker:dev) ─────────────────────────────────────
function isJanusSidecarRunning() {
  return new Promise((resolve) => {
    const child = spawn(
      "docker",
      [
        "ps",
        "--filter",
        "ancestor=canyan/janus-gateway",
        "--format",
        "{{.ID}}",
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim().length > 0));
  });
}

function stopJanusSidecar() {
  return new Promise((resolve) => {
    console.log(`\n${yellow("⏹")}  Stoppe Janus-Sidecar…`);
    const child = spawn(
      "docker",
      ["compose", "-f", "docker-compose.dev.yml", "down"],
      {
        stdio: "inherit",
        shell: false,
      }
    );
    child.on("exit", resolve);
  });
}

async function runWithChecks(task) {
  if (task.key === "docker:dev") {
    const running = await isJanusSidecarRunning();
    if (running) {
      console.log(
        `\n${yellow("⚠")}  Janus-Sidecar (canyan/janus-gateway) läuft noch — ` +
          `der Bridge-Container bringt seinen eigenen Janus mit.`
      );
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      await new Promise((resolve) => {
        rl.question(
          `  ${yellow("▸")} Janus-Sidecar jetzt stoppen? (j/N) `,
          async (answer) => {
            rl.close();
            if (answer.trim().toLowerCase() === "j") {
              await stopJanusSidecar();
            } else {
              console.log(
                `${dim("  Sidecar bleibt laufen — Konflikt auf Port 8188 möglich.")}`
              );
            }
            resolve();
          }
        );
      });
    }
  }
  run(task);
}

// ── Run a task ────────────────────────────────────────────────────────────────
function run(task) {
  console.log(`\n${green("▶")} ${bold(task.key)}  ${dim(task.cmd)}\n`);
  const [bin, ...args] = task.cmd.split(" ");
  const child = spawn(bin, args, { stdio: "inherit", shell: true });
  child.on("exit", (code) => {
    if (code !== 0) {
      console.error(`\n${red("✗")} exited with code ${code}`);
      process.exit(code);
    }
  });
}

// ── Help / task list ──────────────────────────────────────────────────────────
function printHelp(numbered = false) {
  console.log(
    `\n  ${bold("obico-prusalink-bridge")} ${dim("— task runner")}\n`
  );
  let n = 1;
  for (const group of groups) {
    console.log(`  ${cyan(bold(group.name))}`);
    for (const task of group.tasks) {
      const num = numbered ? dim(`${String(n++).padStart(2)}.`) + " " : "    ";
      const key = task.key.padEnd(18);
      console.log(`  ${num}${bold(key)} ${dim(task.desc)}`);
    }
    console.log();
  }
}

// ── Interactive menu (arrow keys) ────────────────────────────────────────────
function interactive() {
  // Build flat render list: group headers + selectable task rows
  const rows = [];
  for (const group of groups) {
    rows.push({ type: "group", label: group.name });
    for (const task of group.tasks) {
      rows.push({ type: "task", task });
    }
  }
  const taskRows = rows.filter((r) => r.type === "task");
  let sel = 0;

  function renderLines() {
    const lines = [];
    lines.push(`  ${bold("obico-prusalink-bridge")} ${dim("— task runner")}`);
    lines.push("");
    for (const row of rows) {
      if (row.type === "group") {
        lines.push(`  ${cyan(bold(row.label))}`);
      } else {
        const active = taskRows[sel] === row;
        const key = row.task.key.padEnd(18);
        const prefix = active ? `  ${yellow("▶")} ` : "    ";
        const label = active ? `${bold(key)}` : `${dim(key)}`;
        lines.push(`${prefix}${label} ${dim(row.task.desc)}`);
      }
    }
    lines.push("");
    lines.push(`  ${dim("↑↓ navigieren · Enter ausführen · Esc abbrechen")}`);
    return lines;
  }

  let drawnLines = 0;

  function draw() {
    const lines = renderLines();
    if (drawnLines > 0) {
      process.stdout.write(`\x1b[${drawnLines}A\x1b[0J`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    drawnLines = lines.length;
  }

  function cleanup() {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h");
  }

  process.stdout.write("\x1b[?25l"); // hide cursor
  draw();

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (key) => {
    if (key === "\x1b[A") {
      // arrow up
      sel = sel > 0 ? sel - 1 : taskRows.length - 1;
      draw();
    } else if (key === "\x1b[B") {
      // arrow down
      sel = sel < taskRows.length - 1 ? sel + 1 : 0;
      draw();
    } else if (key === "\r") {
      // enter
      cleanup();
      process.stdout.write("\n");
      runWithChecks(taskRows[sel].task);
    } else if (key === "\x1b" || key === "\x03") {
      // escape or ctrl+c
      cleanup();
      process.stdout.write("\n");
      process.exit(0);
    }
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────
const arg = process.argv[2];

if (!arg) {
  interactive();
} else if (arg === "--help" || arg === "-h") {
  printHelp(false);
  console.log(`  ${dim("Usage:")} ${cyan("./run.mjs [task]")}\n`);
} else {
  const task = byKey[arg];
  if (!task) {
    console.error(`\n${red("✗")} Unknown task: ${bold(arg)}`);
    printHelp(false);
    process.exit(1);
  }
  runWithChecks(task);
}
