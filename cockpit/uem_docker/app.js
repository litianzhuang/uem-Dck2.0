"use strict";

const BACKEND = "/usr/local/libexec/uem/member_docker.py";
const $ = id => document.getElementById(id);
let healthy = false;
let profiles = [];
let snapshots = [];
let terminalProc = null;
let imagePullProc = null;
let busy = false;

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = String(value);
  if (className) node.className = className;
  return node;
}

function request(action, ...args) {
  // All authorization is rechecked by the current-UID Python helper.
  const argv = ["/usr/bin/python3", BACKEND, action, ...args];
  return cockpit.spawn(argv, {err: "message"}).then(output => JSON.parse(output));
}

// `jupyter-router-status` reports a refusal as JSON on stdout with exit 2, and
// cockpit rejects the spawn on a non-zero exit, so the reply never reached
// JSON.parse and every gateway failure collapsed into a generic sentence.
// This call reads stdout through a stream, bounds it, and continues only on a
// zero exit whose own reply says READY. The raw reply, stderr and the error
// object are never shown: the fixed messages below are the whole contract.
const ROUTER_REPLY_LIMIT = 8192;
const ROUTER_MESSAGES = {
  service: "网页工作区服务发生内部错误，请联系管理员",
  unavailable: "网页工作区网关不可用，请联系管理员",
  unreadable: "无法读取网页工作区网关响应，请联系管理员",
  abnormal: "网页工作区网关响应异常，请联系管理员"
};

function requestRouterStatus() {
  const blocked = (code, message) => ({status: "BLOCKED", code, message});
  return new Promise(resolve => {
    let text = "";
    let streamed = false;
    let overflow = false;
    const collect = chunk => {
      if (overflow) return;
      streamed = true;
      text += String(chunk);
      if (text.length > ROUTER_REPLY_LIMIT) overflow = true;
    };
    const settle = (raw, exitOk) => {
      if (overflow) return resolve(blocked("ROUTER_REPLY_TOO_LARGE", ROUTER_MESSAGES.abnormal));
      let reply;
      try { reply = JSON.parse(raw); } catch (_) { reply = null; }
      if (!reply || typeof reply !== "object" || Array.isArray(reply))
        return resolve(blocked("ROUTER_REPLY_UNREADABLE", ROUTER_MESSAGES.unreadable));
      const message = reply.code === "WORKSPACE_SERVICE_ERROR"
        ? ROUTER_MESSAGES.service : ROUTER_MESSAGES.unavailable;
      // A run that exited non-zero has already denied the request; a READY
      // field written by that same failed run must not open the workspace.
      if (!exitOk) return resolve(blocked(reply.code || "ROUTER_EXIT_FAILED", message));
      if (reply.status !== "READY") return resolve(blocked(reply.code || "ROUTER_NOT_READY", message));
      resolve(reply);
    };
    let proc;
    try {
      proc = cockpit.spawn(["/usr/bin/python3", BACKEND, "jupyter-router-status"], {err: "message"});
    } catch (_) {
      resolve(blocked("ROUTER_SPAWN_FAILED", ROUTER_MESSAGES.unavailable));
      return;
    }
    if (proc && typeof proc.stream === "function") proc.stream(collect);
    proc.then(output => settle(streamed ? text : String(output || ""), true),
      () => settle(streamed ? text : "", false));
  });
}

// The Cockpit shell draws one sidebar for every installed package. Members only
// need their console and a terminal, so trim the host menu for them. The rule is
// a constructed stylesheet on the shell document: Cockpit's CSP refuses inline
// <style>, and a document-level sheet survives the shell re-rendering the menu.
// Cosmetic only: each host page checks authorization on its own.
const MEMBER_MENU_CSS = `
#host-apps li.nav-item { display: none !important; }
#host-apps li.nav-item:has(> a[href="/uem_docker"]),
#host-apps li.nav-item:has(> a[href="/system/terminal"]) { display: list-item !important; }
#host-apps .nav-group-heading { display: none !important; }`;
const hostPermission = cockpit.permission({admin: true});

function trimHostMenu() {
  let doc;
  try {
    if (window.parent === window) return;
    doc = window.parent.document;
  } catch (_) {
    return; // shell not reachable: leave the stock menu alone
  }
  if (hostPermission.allowed !== false || !("adoptedStyleSheets" in doc)) return;
  if (doc.adoptedStyleSheets.some(sheet => sheet.memberMenu)) return;
  const sheet = new window.parent.CSSStyleSheet();
  sheet.replaceSync(MEMBER_MENU_CSS);
  sheet.memberMenu = "uem_docker";
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
}
try {
  hostPermission.addEventListener("changed", trimHostMenu);
} catch (_) {}
trimHostMenu();

function tell(text, error = false) {
  $("message").textContent = text;
  $("message").className = error ? "feedback error" : "feedback";
}

const CAMPUS_BACKEND = "/usr/local/libexec/uem/campus_network.py";
const CAMPUS_PUBLIC_STATE = "/var/lib/uem-campus/public.json";
const CAMPUS_BLOCKING = new Set(["CONNECTED", "AUTHENTICATING", "LOGOUT_PENDING"]);
const CAMPUS_REVIEW = new Set(["AUTHENTICATED_NO_EGRESS", "CONNECTIVITY_LOST",
  "LOGOUT_UNVERIFIED", "UNKNOWN"]);
const CAMPUS_STALE_SECONDS = 180;
const CAMPUS_LABELS = {
  CONNECTED: "校园网已接入",
  AUTHENTICATING: "正在认证",
  AUTHENTICATED_NO_EGRESS: "认证通过但无外网",
  CONNECTIVITY_LOST: "外网已断开",
  LOGOUT_PENDING: "正在注销",
  LOGOUT_UNVERIFIED: "注销未确认",
  DISCONNECTED: "未接入",
  UNKNOWN: "状态未知"
};

function renderCampus(state, updated, transport, present) {
  const blocked = CAMPUS_BLOCKING.has(state);
  // A previous session that cannot be proven ended must not be replaced by
  // another member; the page asks for an administrator instead of retrying.
  const review = present === true && !blocked && CAMPUS_REVIEW.has(state);
  $("campus-state").textContent = CAMPUS_LABELS[state] || CAMPUS_LABELS.UNKNOWN;
  $("campus-state").className = "pill " + (state === "CONNECTED" ? "good" :
    (review || state === "AUTHENTICATED_NO_EGRESS" ? "fail" : "pending"));
  const detail = {
    CONNECTED: "整台工作站已通过校园网认证；其他成员无需也不能重复登录。",
    AUTHENTICATING: "有成员正在认证，请稍后刷新。",
    LOGOUT_PENDING: "管理员正在注销全站连接，请稍后刷新。",
    AUTHENTICATED_NO_EGRESS: "门户认证通过但外网不可达，旧会话未能证实结束；请联系管理员，不要重复登录。",
    CONNECTIVITY_LOST: "外网已断开，但旧门户会话未能证实结束；请管理员先核实并确认，再发起新的登录。",
    LOGOUT_UNVERIFIED: "上次注销未能确认门户会话已结束；请管理员核实后再开放登录。",
    DISCONNECTED: "当前未接入校园网，任一成员可以用自己的账号发起认证。",
    UNKNOWN: present
      ? "无法确认当前共享状态；请管理员核实后再登录。"
      : "尚未读取到共享状态；后端会先探测真实出口，若已有连接将拒绝本次登录。"
  }[state] || "无法确认当前共享状态。";
  let stale = "";
  if (typeof updated === "number") {
    const age = Math.max(0, Math.floor(Date.now() / 1000 - updated));
    if (age > CAMPUS_STALE_SECONDS) {
      stale = " 状态待核实：最后记录于 " + Math.floor(age / 60) + " 分钟前，可能已与实际情况不同。";
    }
  }
  $("campus-detail").textContent = detail + stale;
  $("campus-transport").hidden = transport !== "HTTP_PLAINTEXT";
  $("campus-login").disabled = blocked || review || busy;
  $("campus-user").disabled = blocked || review;
  $("campus-password").disabled = blocked || review;
}

async function refreshCampus() {
  let state = "UNKNOWN";
  let updated = null;
  let transport = "NOT_CONFIGURED";
  let present = false;
  try {
    const parsed = JSON.parse(await cockpit.file(CAMPUS_PUBLIC_STATE).read());
    if (parsed && typeof parsed.state === "string") {
      state = parsed.state;
      updated = typeof parsed.updated === "number" ? parsed.updated : null;
      transport = parsed.transport || "NOT_CONFIGURED";
      present = true;
    }
  } catch (_) {
    present = false;
  }
  renderCampus(state, updated, transport, present);
}

async function refreshProjects() {
  const root = $("project-list");
  try {
    const response = await request("projects");
    if (response.status !== "PASS" || !Array.isArray(response.projects)) throw new Error("unavailable");
    if (!response.configured) root.replaceChildren(element("li", "管理员尚未配置共享项目目录。"));
    else if (!response.projects.length) root.replaceChildren(element("li", "当前没有可读取的共享项目。"));
    else root.replaceChildren(...response.projects.map(project => element("li", project.name + " · " + project.path)));
  } catch (_) {
    root.replaceChildren(element("li", "项目列表不可用；请检查个人 Docker 状态和管理员配置。"));
  }
}

function startWarnings(resources, preview) {
  const warnings = [];
  if (!resources || typeof resources !== "object") return ["资源状态不可用，无法判断是否紧张"];
  if (typeof resources.cpu_percent === "number" && resources.cpu_percent >= 90) warnings.push("CPU 当前使用率至少 90%（瞬时采样）");
  if (resources.memory && resources.memory.total > 0 &&
      (resources.memory.total - resources.memory.available) / resources.memory.total >= 0.9) warnings.push("主机内存使用至少 90%");
  if (resources.swap && resources.swap.total > 0 && typeof resources.swap.available === "number" &&
      (resources.swap.total - resources.swap.available) / resources.swap.total >= 0.9) warnings.push("主机交换空间使用至少 90%，任务可能明显变慢");
  if (preview && typeof preview.memory_limit_bytes === "number" && resources.memory &&
      typeof resources.memory.available === "number" && preview.memory_limit_bytes > resources.memory.available) {
    warnings.push("容器内存上限高于主机当前可用内存；上限不是实际用量或预留内存，运行时可能发生争抢");
  }
  if (!preview || typeof preview.memory_limit_bytes !== "number" || preview.memory_limit_bytes <= 0) {
    warnings.push("容器内存上限未知或未设置");
  }
  if (Array.isArray(resources.gpus) && resources.gpus.some(gpu => gpu.total_mib > 0 && gpu.used_mib / gpu.total_mib >= 0.9)) {
    warnings.push("至少一张 GPU 的显存使用达到 90%（尚未判断本容器是否使用该 GPU）");
  }
  if (typeof resources.cpu_percent !== "number" || !resources.memory ||
      typeof resources.memory.available !== "number" || !Array.isArray(resources.gpus)) warnings.push("部分资源状态未知");
  return warnings;
}

function toneOf(percent) {
  if (typeof percent !== "number") return "ok";
  if (percent >= 90) return "fail";
  if (percent >= 75) return "warn";
  return "ok";
}

function meter(percent, tone) {
  const bar = document.createElement("progress");
  bar.className = "meter " + (tone || "accent");
  bar.max = 100;
  bar.value = typeof percent === "number" ? Math.max(0, Math.min(100, Math.round(percent))) : 0;
  return bar;
}

function metric(label, valueText, percent, note) {
  const item = element("li", null, "metric");
  item.append(element("span", label, "metric-label"));
  item.append(element("span", valueText, "metric-value"));
  if (typeof percent === "number") item.append(meter(percent, toneOf(percent)));
  if (note) item.append(element("span", note, "metric-note"));
  return item;
}

function barRow(name, percent, valueText) {
  const row = element("li", null, "bar-row");
  row.append(element("span", name, "bar-name"));
  row.append(meter(percent, "accent"));
  row.append(element("span", valueText, "bar-num"));
  return row;
}

function gpuRow(label, percent, valueText) {
  const row = element("div", null, "gpu-row");
  row.append(element("span", label, "gpu-label"));
  row.append(typeof percent === "number"
    ? meter(percent, toneOf(percent))
    : element("span", "—", "bar-empty"));
  row.append(element("span", valueText, "gpu-num"));
  return row;
}

function durationText(seconds) {
  if (seconds === null || seconds === undefined) return "时长未知";
  return Math.floor(seconds / 3600) + " 小时 " + Math.floor(seconds % 3600 / 60) + " 分钟";
}

function usageOf(item) {
  return item && item.total ? (item.total - item.available) / item.total * 100 : null;
}

async function refreshResources() {
  const list = $("resource-list");
  const gpuGrid = $("gpu-grid");
  const ownerBlock = $("gpu-owner-block");
  const owners = $("gpu-owners");
  const gpuPanel = $("gpu-panel");
  try {
    const response = await request("resources");
    if (response.status !== "PASS" || !response.resources) throw new Error("unavailable");
    const r = response.resources;
    const gib = bytes => (bytes / (1024 ** 3)).toFixed(1) + " GiB";
    const cards = [];

    cards.push(metric("CPU 使用率",
      typeof r.cpu_percent === "number" ? r.cpu_percent + "%" : "未知",
      typeof r.cpu_percent === "number" ? r.cpu_percent : null,
      typeof r.cpu_percent === "number" ? "最近一次瞬时采样" : "后端未提供瞬时值"));

    for (const [label, item] of [["内存", r.memory], ["根分区磁盘", r.disk_root]]) {
      const used = usageOf(item);
      cards.push(metric(label, used === null ? "未知" : Math.round(used) + "%", used,
        item && item.total
          ? "可用 " + gib(item.available) + " / 总量 " + gib(item.total) + (used >= 90 ? " · 空间紧张，请先协商" : "")
          : "总量不可读"));
    }

    if (!r.swap) {
      cards.push(metric("交换空间", "未知", null, "后端未提供交换空间状态"));
    } else if (r.swap.total === 0) {
      cards.push(metric("交换空间", "未配置", null, "主机未配置 swap，内存压力会直接体现为 OOM"));
    } else {
      const used = usageOf(r.swap);
      cards.push(metric("交换空间", Math.round(used) + "%", used,
        "可用 " + gib(r.swap.available) + " / 总量 " + gib(r.swap.total) + (used >= 90 ? " · 空间紧张" : "")));
    }

    gpuGrid.replaceChildren();
    owners.replaceChildren();
    if (!r.gpus || !r.gpus.length) {
      gpuGrid.hidden = true;
      ownerBlock.hidden = true;
      gpuPanel.hidden = true;
      cards.push(metric("GPU", r.gpus === null ? "不可用" : "未检测到", null,
        r.gpus === null ? "无法读取 GPU 状态" : "主机未检测到可用 GPU"));
    } else {
      gpuGrid.hidden = false;
      gpuPanel.hidden = false;
      for (const gpu of r.gpus) {
        const vram = gpu.total_mib > 0 ? gpu.used_mib / gpu.total_mib * 100 : null;
        const card = element("div", null, "gpu");
        const head = element("div", null, "gpu-head");
        head.append(element("strong", "GPU " + gpu.index));
        head.append(element("span", vram === null ? "显存未知" : Math.round(vram) + "% 显存",
          "gpu-tag " + toneOf(vram)));
        card.append(head);
        card.append(gpuRow("显存", vram, gpu.used_mib + " / " + gpu.total_mib + " MiB"));
        card.append(gpuRow("算力", typeof gpu.utilization === "number" ? gpu.utilization : null,
          typeof gpu.utilization === "number" ? gpu.utilization + "%" : "未知"));
        gpuGrid.append(card);
      }
      ownerBlock.hidden = false;
      if (r.gpu_owners === null) {
        owners.append(element("li", "GPU 使用者未知（系统未提供可用进程信息）", "muted"));
      } else if (!r.gpu_owners || !r.gpu_owners.length) {
        owners.append(element("li", "未发现可识别的计算进程，不代表 GPU 空闲", "muted"));
      } else {
        for (const owner of r.gpu_owners) {
          const target = r.gpus.find(gpu => gpu.index === owner.gpu_index);
          const share = owner.used_mib !== null && target && target.total_mib > 0
            ? Math.min(100, owner.used_mib / target.total_mib * 100) : null;
          const row = element("li", null, "bar-row");
          row.append(element("span", owner.user || "未知", "bar-name"));
          row.append(typeof share === "number" ? meter(share, "accent") : element("span", "—", "bar-empty"));
          row.append(element("span", "GPU " + owner.gpu_index + " · " + durationText(owner.elapsed_seconds), "bar-num"));
          owners.append(row);
        }
      }
    }

    list.replaceChildren(...cards);
    $("resources-updated").textContent = "刚刚更新";
  } catch (_) {
    list.replaceChildren(element("li", "资源状态暂不可用", "muted"));
    gpuGrid.hidden = true;
    ownerBlock.hidden = true;
    gpuPanel.hidden = true;
    $("resources-updated").textContent = "读取失败";
  }
}

async function refreshMemoryUsers() {
  const list = $("memory-users");
  try {
    const response = await request("memory-users");
    if (response.status !== "PASS" || !response.memory_users) throw new Error("unavailable");
    const info = response.memory_users;
    const users = info.users || [];
    const peak = Math.max(1, ...users.map(item => item.rss_bytes || 0));
    const rows = users.map(item => barRow(item.user, (item.rss_bytes || 0) / peak * 100,
      (item.rss_bytes / (1024 ** 3)).toFixed(1) + " GiB"));
    if (!rows.length) rows.push(element("li", "未发现可读取的进程", "muted"));
    if (info.incomplete) rows.push(element("li", "进程信息不完整，或仅显示占用最高的 10 个用户", "muted"));
    list.replaceChildren(...rows);
  } catch (_) {
    list.replaceChildren(element("li", "各用户进程内存：无法读取", "muted"));
  }
}

async function refreshCpuUsers() {
  const list = $("cpu-users");
  try {
    const response = await request("cpu-users");
    if (response.status !== "PASS" || !response.cpu_users) throw new Error("unavailable");
    const info = response.cpu_users;
    const users = info.users || [];
    const peak = Math.max(1, ...users.map(item => item.cpu_percent || 0));
    const rows = users.map(item => barRow(item.user, (item.cpu_percent || 0) / peak * 100,
      item.cpu_percent + "%"));
    if (!rows.length) rows.push(element("li", "未发现可比较的进程", "muted"));
    if (info.incomplete) rows.push(element("li", "进程信息不完整，或仅显示占用最高的 10 个用户", "muted"));
    list.replaceChildren(...rows);
  } catch (_) {
    list.replaceChildren(element("li", "各用户 CPU：无法读取", "muted"));
  }
}

async function refreshMemberStorage() {
  const target = $("member-storage");
  try {
    const response = await request("storage");
    if (response.status !== "PASS" || !response.storage || !response.storage.total) throw new Error("unavailable");
    const {total, available} = response.storage;
    const used = usageOf({total, available});
    const gib = bytes => (bytes / (1024 ** 3)).toFixed(1) + " GiB";
    target.replaceChildren(
      element("p", Math.round(used) + "% 已使用", "storage-value"),
      meter(used, toneOf(used)),
      element("p", "可用 " + gib(available) + " / 总量 " + gib(total) +
        (used >= 90 ? " · 空间紧张，请先协商" : ""), "muted"));
  } catch (_) {
    target.replaceChildren(element("p", "个人 Docker 存储文件系统：未知（请检查个人 Docker 状态）", "muted"));
  }
}

function setBusy(value) {
  busy = value;
  $("create").disabled = value || !healthy;
  $("restore-button").disabled = value || !healthy || !snapshots.length;
  $("image-pull").disabled = value || !healthy;
  $("refresh").disabled = value;
}

async function operation(action, identifier) {
  if (busy) return;
  setBusy(true);
  tell("正在执行操作…");
  try {
    if (action === "start") {
      let warnings;
      try {
        const results = await Promise.allSettled([request("resources"), request("start-preview", identifier)]);
        const response = results[0].status === "fulfilled" ? results[0].value : null;
        const preview = results[1].status === "fulfilled" && results[1].value.status === "PASS" ? results[1].value : null;
        warnings = response && response.status === "PASS" ? startWarnings(response.resources, preview) : ["资源状态不可用，无法判断是否紧张"];
      } catch (_) {
        warnings = ["资源状态不可用，无法判断是否紧张"];
      }
      if (warnings.length && !window.confirm("启动前资源提醒：\n\n" + warnings.join("\n") + "\n\n请查看看板并与其他成员协商。仍要启动吗？")) {
        tell("已取消启动。");
        return;
      }
    }
    const result = await request(action, identifier);
    if (result.status !== "PASS") throw new Error("rejected");
    tell(action === "remove" ? "容器已删除，工作空间仍然保留。" : "操作已完成。");
    await refreshAll(false);
  } catch (_) {
    tell("操作失败或被拒绝；请检查当前用户 Docker 状态。", true);
  } finally {
    setBusy(false);
  }
}

function button(label, onClick, className) {
  const node = element("button", label, className === undefined ? "secondary" : (className || null));
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

const CONTAINER_STATE_LABELS = {
  running: "运行中",
  exited: "已停止",
  created: "已创建",
  paused: "已暂停",
  restarting: "重启中",
  removing: "删除中",
  dead: "异常"
};

function containerStatePill(item) {
  const state = item.state || "";
  const label = CONTAINER_STATE_LABELS[state] || state || "未知";
  const tone = state === "running" ? "good" : (state === "dead" ? "fail" : "idle");
  return element("span", label, "pill " + tone);
}

function renderContainers(items) {
  const root = $("containers");
  root.replaceChildren();
  $("count").textContent = items.length + " 个环境";
  if (!items.length) {
    root.append(element("p", "还没有科研环境。打开「创建环境」选择模板或镜像，即可创建第一个容器；删除容器不会删除工作空间数据。", "muted"));
    return;
  }
  for (const item of items) {
    const card = element("article", "", "container");
    const head = element("div", "", "container-head");
    head.append(element("strong", item.name || item.id.slice(0, 12)));
    head.append(containerStatePill(item));
    card.append(head);
    card.append(element("p", [item.image, item.status, item.id.slice(0, 12)].filter(Boolean).join(" · "), "meta"));
    const actions = element("div", "", "container-actions");
    const extras = [];
    const personalProjects = element("ul", "", "workspace-list");
    personalProjects.hidden = true;
    if (item.state === "running") {
      extras.push(button("查看个人项目", async () => {
        if (busy) return;
        setBusy(true);
        try {
          const result = await request("personal-projects", item.id);
          if (result.status !== "PASS" || !Array.isArray(result.projects)) throw new Error("unavailable");
          personalProjects.hidden = false;
          personalProjects.replaceChildren(...(result.projects.length
            ? result.projects.map(name => element("li", name))
            : [element("li", "当前工作空间没有可列出的个人项目。")]));
          tell("已列出工作空间 " + result.workspace + " 中的个人项目；不包含共享项目。");
        } catch (_) {
          personalProjects.hidden = true;
          tell("无法读取个人项目；请确认容器运行中、工作空间挂载正常且镜像包含兼容的 Python。", true);
        } finally { setBusy(false); }
      }));
      actions.append(button("停止", () => {
        if (window.confirm("停止容器可能中断正在进行的训练。确定停止？")) operation("stop", item.id);
      }));
      actions.append(button("进入终端", () => openTerminal(item.id, item.name)));
      actions.append(button("打开 JupyterLab", async () => {
        if (busy) return;
        setBusy(true);
        // Report the step that failed and the helper's own `detail`. A single
        // generic sentence used to send members hunting for certificate
        // problems on hosts whose gateway was healthy all along.
        let stage = "检查网页工作区网关";
        const reason = value => (value && typeof value.detail === "string" && value.detail) ||
          (value && typeof value.status === "string" && value.status) || "无详细信息";
        // jupyter-prepare answers a refusal as JSON on stdout with a non-zero
        // exit status, and cockpit rejects with the stderr text alone, so the
        // helper's `detail` was being thrown away. Merge the streams and read
        // the JSON back out of whichever branch carried it.
        const parseReply = value => {
          const text = typeof value === "string" ? value
            : String((value && (value.message || value.problem)) || "");
          const match = text.match(/\{[\s\S]*\}/);
          if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
          return { status: "BLOCKED", detail: text.trim() };
        };
        try {
          const gateway = await requestRouterStatus();
          if (gateway.status !== "READY") throw new Error(gateway.message);
          if (gateway.cockpit_origin !== window.location.origin) throw new Error("网关地址与当前控制台不一致");
          stage = "启动 JupyterLab 会话";
          let session;
          try { session = await request("jupyter-status", item.id); } catch (_) { session = null; }
          if (!session || session.session?.state !== "RUNNING") {
            session = await request("jupyter-start", item.id);
            if (session.status !== "PASS" || session.session?.state !== "RUNNING")
              throw new Error("会话未运行（" + reason(session) + "）");
          }
          stage = "准备工作区授权票据";
          // The helper reports a refusal as JSON on stdout with a non-zero exit
          // status, and cockpit drops that output when it rejects the spawn, so
          // a refusal reached the page as a bare exit code. Run the helper
          // through `sh` (arguments passed positionally, never interpolated) to
          // force a zero exit and read the helper's own `detail`.
          const prepared = await cockpit.spawn(
            ["/bin/sh", "-c", '"$@" 2>&1; exit 0', "uem",
             "/usr/bin/python3", BACKEND, "jupyter-prepare", item.id], {err: "out"});
          const ready = parseReply(prepared);
          if (ready.status !== "PASS" || ready.bootstrap !== "ISSUED") throw new Error(reason(ready));
          const target = new URL(ready.origin);
          if (target.protocol !== "https:" || target.origin !== ready.origin ||
              !/^[A-Za-z0-9_-]{43,128}$/.test(ready.bootstrap_secret))
            throw new Error("票据格式不符合约定");
          const form = document.createElement("form");
          form.method = "post";
          form.action = target.origin + "/__uem/session";
          // A `_top` navigation would leave this Cockpit page, whose WebSocket
          // disconnect ends the member's logind Cockpit session within seconds;
          // the browser ticket is bound to that session, so the workspace would
          // lose all authorization moments after opening (verified on the
          // acceptance VM: every request started failing 403 while JupyterLab
          // was still loading). Opening a new tab keeps this page — and the
          // session — alive; closing this tab revokes the workspace within the
          // ticket lifetime, which preserves the logout-revokes-access design.
          form.target = "_blank";
          const secret = document.createElement("input");
          secret.type = "hidden";
          secret.name = "bootstrap";
          secret.value = ready.bootstrap_secret;
          form.append(secret);
          document.body.append(form);
          form.submit();
          form.remove();
          tell("已在新标签页打开 JupyterLab。请保留本 Cockpit 页面；关闭它会使网页工作区在数分钟内失效。");
        } catch (error) {
          const text = error && typeof error.message === "string" && error.message ? error.message : "未知错误";
          tell("无法打开网页工作区：" + stage + "失败（" + text + "）。", true);
        } finally { setBusy(false); }
      }, ""));
      extras.push(button("新建项目目录", async () => {
        if (busy) return;
        const name = window.prompt("输入新项目名称（小写字母开头，可包含数字和连字符）：");
        if (name === null) return;
        if (!/^[a-z][a-z0-9-]{1,39}$/.test(name)) {
          tell("项目名需为 2–40 个小写字母、数字或连字符，以字母开头。", true); return;
        }
        if (!window.confirm("将在本人工作空间 projects/" + name + " 下创建推荐目录。已有同名项目不会被覆盖。继续？")) return;
        setBusy(true);
        try {
          const result = await request("project-init", item.id, name);
          if (result.status !== "PASS" || result.result !== "CREATED") throw new Error("unconfirmed");
          tell("项目目录已创建：projects/" + name + "。请在本人工作空间查看。");
        } catch (_) {
          tell("项目创建未完成或无法确认：请检查是否同名、容器是否有兼容的 Python，以及工作空间和临时目录后再重试。", true);
        } finally { setBusy(false); }
      }));
      extras.push(button("检查 JupyterLab", async () => {
        if (busy) return;
        setBusy(true);
        try {
          const result = await request("jupyter-probe", item.id);
          if (result.status !== "PASS" || !["present", "missing"].includes(result.jupyterlab_command)) throw new Error("unknown");
          tell(result.jupyterlab_command === "present"
            ? "已找到 JupyterLab 命令；网页入口需管理员完成域名和 HTTPS 配置。"
            : "容器的默认 PATH 中未找到 JupyterLab 命令；未启动或安装任何服务。");
        } catch (_) { tell("无法检查 JupyterLab，请确认容器运行状态和镜像支持 /bin/sh。", true); }
        finally { setBusy(false); }
      }));
      extras.push(button("启动网页工作区", async () => {
        if (busy) return;
        setBusy(true);
        try {
          const result = await request("jupyter-start", item.id);
          if (result.status !== "PASS" || result.session?.state !== "RUNNING") throw new Error("unconfirmed");
          tell("JupyterLab 已在本人容器内启动；可在管理员完成 HTTPS 配置后打开。");
        } catch (_) {
          tell("网页工作区未通过自检。请确认容器运行中、工作空间挂载正常，且镜像包含 Python 3 与 JupyterLab。", true);
        } finally { setBusy(false); }
      }));
      extras.push(button("查看工作区状态", async () => {
        if (busy) return;
        setBusy(true);
        try {
          const result = await request("jupyter-status", item.id);
          if (result.status !== "PASS" || !["RUNNING", "NOT_RUNNING"].includes(result.session?.state)) throw new Error("unverified");
          tell(result.session.state === "RUNNING" ? "本人容器的 JupyterLab 会话正在运行。" : "本人容器的 JupyterLab 会话未运行。");
        } catch (_) { tell("无法确认工作区状态，请检查容器和会话后重试。", true); }
        finally { setBusy(false); }
      }));
      extras.push(button("停止网页工作区", async () => {
        if (busy) return;
        setBusy(true);
        try {
          const result = await request("jupyter-stop", item.id);
          if (result.status !== "PASS" || result.session?.state !== "STOPPED") throw new Error("unconfirmed");
          tell("已停止本人容器内的 JupyterLab 会话并清除本次凭据；工作空间数据未删除。");
        } catch (_) { tell("无法确认网页工作区已停止，请检查容器状态后重试。", true); }
        finally { setBusy(false); }
      }));
    } else {
      actions.append(button("启动", () => operation("start", item.id), ""));
    }
    extras.push(button("检查工作空间", async () => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await request("workspace-check", item.id);
        if (result.status !== "PASS" || result.mount !== "MATCHED") throw new Error("unknown");
        tell("容器挂载与本人工作空间 " + result.workspace + " 的记录一致；实际读写和多用户隔离尚未验证。");
      } catch (_) { tell("无法确认工作空间挂载，请检查容器和个人 Docker 状态。", true); }
      finally { setBusy(false); }
    }));
    actions.append(button("查看日志", () => showLogs(item.id)));
    if (item.state !== "running") {
      extras.push(button("保存版本", async () => {
        const version = window.prompt("为当前软件环境输入版本名（如 baseline 或 v2）。工作空间中的文件不会打包进镜像：", "baseline");
        if (version === null) return;
        if (!/^[a-z][a-z0-9-]{0,29}$/.test(version)) {
          tell("版本名需为 1–30 个小写字母、数字或连字符，以字母开头。", true);
          return;
        }
        if (!window.confirm("确认保存当前容器的软件依赖版本？这可能需要较长时间并占用磁盘空间。")) return;
        setBusy(true);
        tell("正在保存当前软件环境快照…");
        try {
          const saved = await request("snapshot", item.id, version);
          if (saved.status !== "PASS") throw new Error("not saved");
          tell("版本已保存。工作空间数据未包含在镜像中，请独立备份。");
          await refreshAll(false);
        } catch (_) {
          tell("保存失败。请确认容器已停止、版本名未重复且有足够磁盘空间。", true);
        } finally {
          setBusy(false);
        }
      }));
      extras.push(button("删除容器", () => {
        if (window.confirm("确定删除该容器？工作空间卷仍然保留，容器内部未持久化的修改会丢失。")) {
          operation("remove", item.id);
        }
      }, "danger"));
    }
    card.append(actions);
    if (extras.length) {
      const more = element("details", "", "more");
      const moreRow = element("div", "", "controls");
      moreRow.append(...extras);
      more.append(element("summary", "更多操作"), moreRow);
      card.append(more);
    }
    card.append(personalProjects);
    root.append(card);
  }
}

async function showLogs(identifier) {
  $("logs-panel").hidden = false;
  $("logs").textContent = "读取中…";
  try {
    const data = await request("logs", identifier);
    if (data.status !== "PASS") throw new Error("not allowed");
    $("logs").textContent = data.logs || "没有可显示的日志。";
  } catch (_) {
    $("logs").textContent = "日志不可用或未获授权。";
  }
}

function closeTerminal() {
  if (terminalProc) terminalProc.close();
  terminalProc = null;
  $("terminal-panel").hidden = true;
  $("terminal-input").disabled = true;
  $("terminal-send").disabled = true;
}

function openTerminal(identifier, name) {
  closeTerminal();
  $("terminal-panel").hidden = false;
  $("terminal-title").textContent = "容器终端 · " + (name || identifier.slice(0, 12));
  $("terminal-output").textContent = "正在连接本人容器的 /bin/sh…\n";
  const argv = ["/usr/bin/python3", BACKEND, "terminal", identifier];
  try {
    const process = cockpit.spawn(argv, {pty: true});
    terminalProc = process;
    $("terminal-input").disabled = false;
    $("terminal-send").disabled = false;
    $("terminal-input").focus();
    process.stream(chunk => {
      const output = $("terminal-output");
      // Text-only terminal preview: remove basic ANSI escape codes (not xterm emulation).
      const clean = String(chunk).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
      output.textContent = (output.textContent + clean).slice(-100000);
      output.scrollTop = output.scrollHeight;
      return chunk.length;
    });
    process.then(() => {
      if (terminalProc === process) {
        $("terminal-output").textContent += "\n[终端会话结束]";
        $("terminal-input").disabled = true;
        $("terminal-send").disabled = true;
        terminalProc = null;
      }
    }).catch(() => {
      if (terminalProc === process) {
        $("terminal-output").textContent += "\n[终端不可用或连接已断开]";
        $("terminal-input").disabled = true;
        $("terminal-send").disabled = true;
        terminalProc = null;
      }
    });
  } catch (_) {
    $("terminal-output").textContent = "终端连接失败。";
  }
}

async function refreshAll(checkStatus = true) {
  if (checkStatus) {
    $("status").textContent = "检查中";
    $("status").className = "pill pending";
    const data = await request("status");
    if (data.status !== "PASS" || !data.preflight) throw new Error("Preflight failed");
    healthy = data.preflight.status === "PASS";
    $("status").textContent = healthy ? "个人 Docker 已就绪" : "安全检查未通过";
    $("status").className = "pill " + (healthy ? "good" : "fail");
    $("status-detail").textContent = healthy
      ? "已确认当前账号的 Rootless Docker 前置条件。"
      : "当前用户 Docker 不符合安全前提；请联系管理员。";
    const checks = $("checks");
    checks.replaceChildren();
    for (const item of data.preflight.checks || []) {
      checks.append(element("li", item.id + "：" + item.result + " · " + item.detail,
                            item.result === "PASS" ? "good" : "fail"));
    }
  }
  if (!healthy) {
    profiles = [];
    $("profile").replaceChildren(element("option", "安全检查未通过"));
    $("containers").replaceChildren(element("p", "安全检查未通过，不能操作容器。"));
    $("workspaces").replaceChildren(element("li", "不可用"));
    $("version-selector").replaceChildren(element("option", "不可用"));
    snapshots = [];
    return;
  }
  const [containers, spaces, catalogResult, versionsResult] = await Promise.all([
    request("list"), request("workspaces"),
    request("profiles").catch(() => null), request("snapshots").catch(() => null)
  ]);
  if ([containers, spaces].some(x => !x || x.status !== "PASS")) {
    throw new Error("Backend refused request");
  }
  const catalog = catalogResult && catalogResult.status === "PASS" ? catalogResult : null;
  const versions = versionsResult && versionsResult.status === "PASS" ? versionsResult : null;
  profiles = catalog ? catalog.profiles || [] : [];
  const selector = $("profile");
  const selected = selector.value;
  selector.replaceChildren();
  const custom = element("option", "自主选择镜像");
  custom.value = "member-custom";
  selector.append(custom);
  const customGpu = element("option", "自主选择镜像 · 请求 GPU（待验证）");
  customGpu.value = "member-gpu";
  selector.append(customGpu);
  for (const item of profiles) {
    const option = element("option", item.label + (item.gpu ? " · GPU/CDI（待验证）" : " · CPU"));
    option.value = item.id;
    selector.append(option);
  }
  if (["member-custom", "member-gpu"].includes(selected) || profiles.some(x => x.id === selected)) selector.value = selected;
  $("profile-detail").textContent = catalog
    ? "可选择模板或输入镜像引用；创建时不会自动下载。"
    : "模板列表不可用；仍可输入镜像引用。";
  const workspaceList = $("workspaces");
  workspaceList.replaceChildren();
  const existing = $("existing-workspaces");
  existing.replaceChildren();
  if (!(spaces.workspaces || []).length) workspaceList.append(element("li", "暂无工作空间"));
  for (const name of spaces.workspaces || []) {
    workspaceList.append(element("li", name));
    const option = element("option", name);
    option.value = name;
    existing.append(option);
  }
  snapshots = versions ? versions.snapshots || [] : [];
  $("version-count").textContent = versions ? snapshots.length + " 个版本" : "版本列表不可用";
  const versionsSelect = $("version-selector");
  const currentVersion = versionsSelect.value;
  versionsSelect.replaceChildren();
  if (!snapshots.length) versionsSelect.append(element("option", versions ? "尚无版本快照" : "版本列表不可用"));
  for (const snapshot of snapshots) {
    const option = element("option",
      snapshot.workspace + " · " + (snapshot.version || "未命名") + " · " + snapshot.id.slice(7, 19));
    option.value = snapshot.id;
    versionsSelect.append(option);
  }
  if (snapshots.some(x => x.id === currentVersion)) versionsSelect.value = currentVersion;
  renderContainers(containers.containers || []);
}

async function reload() {
  setBusy(true);
  try {
    await refreshAll(true);
  } catch (_) {
    healthy = false;
    $("status").textContent = "当前状态不可用";
    $("status").className = "pill fail";
    tell("后端或模板不可用；检查 Rootless Docker 与管理员配置。", true);
  } finally {
    setBusy(false);
  }
}


async function pullReviewedImage() {
  if (busy || !healthy) return;
  const isCustom = ["member-custom", "member-gpu"].includes($("profile").value);
  const reference = $("custom-image").value.trim();
  const profile = profiles.find(x => x.id === $("profile").value);
  if ((!isCustom && !profile) || (isCustom && !reference)) { tell("请输入镜像引用。", true); return; }
  if (!window.confirm("下载镜像：" + (isCustom ? reference : profile.label) +
    "？镜像可能较大并占用个人 Docker 存储空间。请确认已获得网络下载权限。")) return;
  setBusy(true);
  const output = $("image-pull-output");
  output.hidden = false;
  output.textContent = "正在下载镜像…\n";
  tell("正在通过当前用户的 Docker 准备镜像。");
  try {
    const process = cockpit.spawn(
      ["/usr/bin/python3", BACKEND, isCustom ? "pull-custom" : "pull", isCustom ? reference : profile.id], {pty: true}
    );
    imagePullProc = process;
    process.stream(chunk => {
      // Docker progress can be large. Keep only a small readable preview.
      const clean = String(chunk).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
      output.textContent = (output.textContent + clean).slice(-16000);
      output.scrollTop = output.scrollHeight;
      return chunk.length;
    });
    await process;
    tell("镜像已下载到本人 Docker。现在可创建环境。");
  } catch (_) {
    tell("镜像下载未完成。可能是网络不可达、存储不足或 Rootless 权限不符合要求。", true);
  } finally {
    imagePullProc = null;
    setBusy(false);
  }
}

$("image-pull").addEventListener("click", pullReviewedImage);
$("refresh").addEventListener("click", reload);
$("projects-refresh").addEventListener("click", refreshProjects);
$("refresh").addEventListener("click", refreshProjects);
$("refresh").addEventListener("click", refreshResources);
$("refresh").addEventListener("click", refreshMemoryUsers);
$("refresh").addEventListener("click", refreshCpuUsers);
$("refresh").addEventListener("click", refreshMemberStorage);
$("logout").addEventListener("click", () => cockpit.logout());
$("close-logs").addEventListener("click", () => { $("logs-panel").hidden = true; });
$("close-terminal").addEventListener("click", closeTerminal);
$("terminal-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!terminalProc) return;
  const input = $("terminal-input");
  terminalProc.input(input.value + "\n", true);
  input.value = "";
});
// Stable codes from a structured create refusal; anything else stays generic.
const CREATE_ERRORS = {
  IMAGE_NOT_LOCAL: "当前用户尚未下载该镜像，请先点击「下载所选镜像」。",
  NAME_TAKEN: "环境名称已被使用，请换一个名称。",
  WORKSPACE_BUSY: "该工作空间正在被其他运行中的环境使用，请先停止原环境。",
  INVALID_PROFILE: "镜像模板或镜像引用不符合要求，请重新选择。",
  ROOTLESS_NOT_READY: "个人 Docker 尚未就绪，请联系管理员检查。"
};

$("create-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !healthy) return;
  const name = $("environment-name").value.trim();
  const workspace = $("workspace").value.trim();
  const profile = $("profile").value;
  const image = $("custom-image").value.trim();
  const isCustom = ["member-custom", "member-gpu"].includes(profile);
  const memory = $("custom-memory").value;
  const customProfile = memory === "8g" ? profile : "member-" + (profile === "member-gpu" ? "gpu" : "cpu") + "-" + memory;
  if (isCustom && !image) { tell("请输入镜像引用。", true); return; }
  if (!$("create-form").reportValidity()) return;
  if (!window.confirm("确认使用选定镜像创建新环境？不会自动启动，也不会删除原有数据。" + (profile === "member-gpu" ? " 此选项请求访问所有可用 GPU；GPU 是共享资源，兼容性尚未验收。" : ""))) return;
  setBusy(true);
  tell("正在创建个人环境…");
  try {
    let created;
    try {
      created = isCustom ? await request("create", name, customProfile, workspace, image) : await request("create", name, profile, workspace);
    } catch (_) {
      tell("创建失败。镜像可能未下载、引用无效，或该工作空间有运行中的容器。", true);
      return;
    }
    // Exit 0 with status BLOCKED is a structured refusal, not a creation.
    if (created.status === "BLOCKED") {
      tell(CREATE_ERRORS[created.code] || "无法创建环境，请检查当前环境状态。", true);
      return;
    }
    if (created.status !== "PASS") {
      tell("创建失败。镜像可能未下载、引用无效，或该工作空间有运行中的容器。", true);
      return;
    }
    tell("环境已创建。请在列表中启动；工作空间会独立保留。");
    $("environment-name").value = "";
    // The container exists now; a refresh failure must never read as a failed
    // creation or invite a second create.
    try {
      await refreshAll(false);
    } catch (_) {
      tell("环境已创建，但列表刷新失败。请点击「刷新状态」查看，不要重复创建。", true);
    }
  } finally {
    setBusy(false);
  }
});


$("restore-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !healthy || !snapshots.length) return;
  const name = $("restore-name").value.trim();
  const snapshotId = $("version-selector").value;
  if (!$("restore-form").reportValidity() || !snapshots.some(x => x.id === snapshotId)) return;
  if (!window.confirm("从选中软件版本创建新容器？原容器不会被覆盖。工作空间需要没有其他运行中的容器。")) return;
  setBusy(true);
  tell("正在恢复软件环境…");
  try {
    const response = await request("restore", name, snapshotId);
    if (response.status !== "PASS") throw new Error("restore refused");
    $("restore-name").value = "";
    tell("新环境已创建。启动前请核对工作空间和依赖版本。");
    await refreshAll(false);
  } catch (_) {
    tell("恢复失败。可能是工作空间正在使用、镜像不可用或管理员撤销了原模板。", true);
  } finally {
    setBusy(false);
  }
});

$("campus-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  const username = $("campus-user").value.trim();
  let password = $("campus-password").value;
  // Clear the field before the request so the secret does not linger in the DOM.
  $("campus-password").value = "";
  if (!username || !password) {
    $("campus-warning").hidden = false;
    $("campus-warning").textContent = "请输入校园网账号和密码。";
    return;
  }
  setBusy(true);
  $("campus-warning").hidden = true;
  tell("正在连接校园网…");
  try {
    // The helper reads credentials from stdin only; they never enter argv,
    // browser storage or the page URL.
    // No root channel: the helper talks to the root-owned campus broker over a
    // Unix socket that only serves the campus actions and identifies the caller
    // from SO_PEERCRED.
    const process = cockpit.spawn(["/usr/bin/python3", CAMPUS_BACKEND, "login"],
      {err: "message"});
    process.input(JSON.stringify({username, password}));
    password = null;
    const result = JSON.parse(await process);
    tell(result.state === "CONNECTED"
      ? "校园网已接入，整台工作站现在都有外网访问。"
      : "门户响应已收到，但外网仍不可达；请联系管理员检查。",
      result.state !== "CONNECTED");
  } catch (error) {
    password = null;
    $("campus-warning").hidden = false;
    $("campus-warning").textContent = "校园网连接未完成：" +
      ((error && error.message) || "请稍后重试或联系管理员");
    tell("校园网连接未完成。", true);
  } finally {
    setBusy(false);
    await refreshCampus();
  }
});

cockpit.user().then(user => {
  $("session").textContent = "登录账户：" + user.name;
}).catch(() => {
  $("session").textContent = "登录身份由 Cockpit/PAM 管理";
});
reload();
refreshCampus();
refreshProjects();
refreshResources();
refreshMemoryUsers();
refreshCpuUsers();
window.setInterval(refreshCpuUsers, 120000);
window.setInterval(refreshCampus, 30000);
window.setInterval(refreshMemoryUsers, 120000);
refreshMemberStorage();
window.setInterval(refreshResources, 30000);
window.setInterval(refreshMemberStorage, 120000);
