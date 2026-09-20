const taskIdPattern = /^SL-P\d+-\d{3}$/u;
const states = new Set(["planned", "ready", "in_progress", "review", "done", "blocked"]);

export function validateFrameworkSsot(markdown) {
  const taskSection = section(markdown, "## 8. 原子任务账本", "## 9. 并行施工规则");
  const evidenceSection = section(markdown, "## 11. 验收记录", "## 12. 变更记录");
  const taskRows = parseRows(taskSection);
  for (const cells of taskRows) {
    const rawId = cells[0] ?? "";
    if (isTableMetadata(rawId, "ID")) continue;
    const id = unquote(rawId);
    if (!taskIdPattern.test(id)) throw new Error(`Malformed SSOT task id: ${rawId}`);
  }
  const tasks = taskRows
    .filter((cells) => taskIdPattern.test(unquote(cells[0] ?? "")))
    .map((cells) => ({
      id: unquote(cells[0]),
      state: cells[1],
      dependencies: parseDependencies(cells[2] ?? "", unquote(cells[0])),
    }));

  if (tasks.length === 0) throw new Error("SSOT task ledger is empty.");
  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new Error(`Duplicate SSOT task id: ${task.id}`);
    if (!states.has(task.state)) throw new Error(`Unknown SSOT task state for ${task.id}: ${task.state}`);
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) throw new Error(`${task.id} depends on unknown task ${dependency}.`);
      if (dependency === task.id) throw new Error(`${task.id} cannot depend on itself.`);
    }
  }
  assertAcyclic(byId);

  const evidenceRows = parseRows(evidenceSection);
  for (const cells of evidenceRows) {
    const rawId = cells[0] ?? "";
    if (isTableMetadata(rawId, "taskId")) continue;
    const id = unquote(rawId);
    if (!taskIdPattern.test(id)) throw new Error(`Malformed SSOT evidence task id: ${rawId}`);
  }
  const evidenceIds = new Set(evidenceRows
    .map((cells) => unquote(cells[0] ?? ""))
    .filter((id) => taskIdPattern.test(id)));
  for (const task of tasks) {
    if (task.state === "done" && !evidenceIds.has(task.id)) {
      throw new Error(`Done task ${task.id} is missing an acceptance record.`);
    }
  }
  return { tasks, evidenceIds: [...evidenceIds].sort() };
}

function isTableMetadata(value, header) {
  return value === header || /^-+$/u.test(value);
}

function parseDependencies(value, taskId) {
  const normalized = value.trim();
  if (normalized === "—") return [];
  if (normalized.length === 0) {
    throw new Error(`Missing SSOT dependencies for ${taskId}.`);
  }
  return normalized.split(",").map((token) => {
    const dependency = unquote(token.trim());
    if (token.trim() !== `\`${dependency}\`` || !taskIdPattern.test(dependency)) {
      throw new Error(`Malformed SSOT task reference in dependencies for ${taskId}: ${token.trim()}`);
    }
    return dependency;
  });
}

function parseRows(markdown) {
  const rows = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    if (!line.endsWith("|")) {
      throw new Error(`Malformed SSOT table row: ${line}`);
    }
    rows.push(line.slice(1, -1).split("|").map((cell) => cell.trim()));
  }
  return rows;
}

function section(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);
  const end = markdown.indexOf(endHeading);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`SSOT section boundary is missing: ${startHeading}`);
  }
  return markdown.slice(start, end);
}

function unquote(value) {
  return value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1) : value;
}

function assertAcyclic(tasks) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`SSOT dependency cycle contains ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
}
