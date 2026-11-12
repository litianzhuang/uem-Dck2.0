"use strict";

const ADMIN_BACKEND = "/usr/local/sbin/uem-admin-members.py";
const CAMPUS_BACKEND = "/usr/local/libexec/uem/campus_network.py";
const $a = id => document.getElementById(id);
const permission = cockpit.permission({admin: true});
let busy = false;

// Tab switching inside the admin page. The standalone test DOM has no such
// tabs, so the whole block is a no-op there.
(() => {
  const tabs = Array.from(document.querySelectorAll("[data-admin-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-admin-panel]"));
  if (!tabs.length || !panels.length) return;
  const show = name => {
    for (const panel of panels) panel.hidden = panel.dataset.adminPanel !== name;
    for (const tab of tabs) {
      if (tab.dataset.adminTab === name) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
  };
  for (const tab of tabs) tab.addEventListener("click", () => show(tab.dataset.adminTab));
  show(tabs[0].dataset.adminTab);
})();

// Members cannot use this page, but if one types the URL the shell menu should
// still not offer them the host pages. Same rule as app.js: a constructed sheet
// on the shell document, because Cockpit's CSP refuses inline <style>.
const MEMBER_MENU_CSS = `
#host-apps li.nav-item { display: none !important; }
#host-apps li.nav-item:has(> a[href="/uem_docker"]),
#host-apps li.nav-item:has(> a[href="/system/terminal"]) { display: list-item !important; }
#host-apps .nav-group-heading { display: none !important; }`;
function trimHostMenu() {
  let doc;
  try {
    if (window.parent === window) return;
    doc = window.parent.document;
  } catch (_) {
    return; // shell not reachable: leave the stock menu alone
  }
  if (permission.allowed !== false || !("adoptedStyleSheets" in doc)) return;
  if (doc.adoptedStyleSheets.some(sheet => sheet.memberMenu)) return;
  const sheet = new window.parent.CSSStyleSheet();
  sheet.replaceSync(MEMBER_MENU_CSS);
  sheet.memberMenu = "uem_docker";
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
}
try {
  permission.addEventListener("changed", trimHostMenu);
} catch (_) {}
trimHostMenu();

const MEMBER_STATE_LABELS = {
  ACTIVE: "正常",
  CREDENTIALS_LOCKED: "凭据未设置",
  DISABLED: "已停用",
  DELETED: "已删除",
  UNKNOWN: "未知"
};

function stateLabel(state) {
  return MEMBER_STATE_LABELS[state] || state || "未知";
}

function node(tag, value, className) {
  const item = document.createElement(tag);
  if (value !== undefined) item.textContent = String(value);
  if (className) item.className = className;
  return item;
}

function backend(action, member, extra) {
  // Only root may execute the account helper, and Cockpit independently
  // validates the user's right to become root. No 'try' downgrade allowed.
  const args = ["/usr/bin/python3", ADMIN_BACKEND, action];
  if (member !== undefined) args.push(member);
  if (extra !== undefined) args.push(extra);
  return cockpit.spawn(args, {superuser: "require", err: "message"})
    .then(output => JSON.parse(output));
}

function notice(message, error = false) {
  $a("admin-message").textContent = message;
  $a("admin-message").className = error ? "feedback error" : "feedback";
}

const CAMPUS_ADMIN_LABELS = {
  CONNECTED: "已接入",
  AUTHENTICATING: "正在认证",
  LOGOUT_PENDING: "正在注销",
  AUTHENTICATED_NO_EGRESS: "认证通过但无外网",
  CONNECTIVITY_LOST: "外网已断开",
  LOGOUT_UNVERIFIED: "注销未确认",
  DISCONNECTED: "未接入",
  UNKNOWN: "状态未知"
};

function campusCall(action, extra) {
  // No superuser channel: the helper talks to the root-owned campus broker over
  // its Unix socket, and the broker authorises the caller from SO_PEERCRED of
  // this administrator. Cockpit is not asked to grant root here.
  const args = ["/usr/bin/python3", CAMPUS_BACKEND, action].concat(extra || []);
  return cockpit.spawn(args, {err: "message"}).then(output => JSON.parse(output));
}

function campusNotice(message, error = false) {
  $a("campus-admin-message").textContent = message;
  $a("campus-admin-message").className = error ? "feedback error" : "feedback";
}

function renderCampusAdmin(data) {
  const state = data && typeof data.state === "string" ? data.state : "UNKNOWN";
  const pill = $a("campus-admin-state");
  pill.textContent = CAMPUS_ADMIN_LABELS[state] || CAMPUS_ADMIN_LABELS.UNKNOWN;
  pill.className = "pill " + (state === "CONNECTED" ? "good"
    : (state === "DISCONNECTED" ? "pending" : "fail"));
  const parts = [];
  if (data && data.result) parts.push("结果：" + data.result);
  if (data && typeof data.seq === "number") parts.push("序号：" + data.seq);
  if (data && typeof data.initiating_uid === "number") parts.push("发起 UID：" + data.initiating_uid);
  if (data && data.legacy_keepalive) parts.push("旧保活：" + data.legacy_keepalive);
  if (data && data.egress) parts.push("外网探测：" + data.egress);
  if (data && data.transport) parts.push("门户传输：" + data.transport);
  $a("campus-admin-detail").textContent = parts.length ? parts.join(" · ")
    : "共享状态未提供细节；真实门户会话是否仍存在需在门户侧核实。";
  // Logout and recovery both affect every member, so they stay available only
  // to a confirmed administrator.
  $a("campus-admin-logout").disabled = permission.allowed !== true || busy;
  $a("campus-admin-recover").disabled = permission.allowed !== true || busy;
}

async function refreshCampusAdmin(showError) {
  try {
    renderCampusAdmin(await campusCall("status"));
  } catch (exc) {
    const pill = $a("campus-admin-state");
    pill.textContent = CAMPUS_ADMIN_LABELS.UNKNOWN;
    pill.className = "pill fail";
    $a("campus-admin-detail").textContent =
      "无法读取共享状态：校园网 broker 未安装或未运行；真实门户状态未验证。";
    if (showError) campusNotice("读取校园网状态失败：" + (exc && exc.message ? exc.message : "未知错误"), true);
  }
}

function setBusy(value) {
  busy = value;
  $a("admin-create").disabled = value || permission.allowed !== true;
  $a("admin-create-project").disabled = value || permission.allowed !== true;
  $a("inspect-membership").disabled = value || permission.allowed !== true;
  $a("grant-membership").disabled = value || permission.allowed !== true;
  $a("revoke-membership").disabled = value || permission.allowed !== true;
  $a("admin-refresh").disabled = value || permission.allowed !== true;
  document.querySelectorAll(".session-revoke, .admin-action").forEach(button => {
    // Account state is a separate, permanent reason to stay disabled: a row for
    // a DISABLED/UNKNOWN/DELETED member must not become clickable again just
    // because an unrelated operation finished or permission resolved.
    button.disabled = value || permission.allowed !== true || Boolean(button.blockedReason);
  });
}

async function adminAction(action, member) {
  if (busy || permission.allowed !== true) return;
  const questions = {
    disable: "停用将尝试撤销该成员的受管理项目组资格、终止会话和容器、停止 Rootless Docker 并禁用 linger；可能中断 SSH 会话和训练任务，请先保存进度。未受管理的旧进程和其他 ACL 需核查，恢复后项目资格须重新授权。HOME、镜像和数据卷保留。确认继续？",
    enable: "仅启用已禁用账户；将锁定口令并解除过期，尝试恢复 Docker 和 linger。失败时尝试重新锁定和过期；既有容器可能启动，SSH 公钥未禁用。确认继续？",
    recover: "仅启用已禁用账户；将锁定口令并解除过期，尝试恢复 Docker 和 linger。失败时尝试重新锁定和过期；既有容器可能启动，SSH 公钥未禁用。确认继续？",
    delete: "软删除会先尝试停用并撤销该成员的受管理项目组资格；未保存的训练进度可能丢失，恢复后项目资格须重新授权。保留账户、HOME、镜像和数据卷。确认继续？",
    restore: "恢复只移除软删除标记；账户仍保持禁用，需单独启用。确认操作？",
    "setup-docker": "将尝试配置该成员的 Rootless Docker 并启用 linger，使训练在注销后继续；失败后的受控重试不会解除账户停用，既有容器可能按策略启动。确认操作？",
    "revoke-all-sessions": "将终止该成员所有可撤销的 Cockpit/SSH 会话，可能中断训练；其他服务会话需人工核查。确认操作？",
    "revoke-tokens": "将删除私有运行目录中的 Jupyter token/票据文件；运行中服务的 token 和连接不会因此失效，浏览器票据持久化尚未实现。确认操作？"
  };
  if (questions[action] && !window.confirm(member + "：" + questions[action])) return;
  if ((action === "disable" || action === "delete") &&
      !window.confirm("再次确认：" + member + " 的运行任务将被停止，未保存进度可能丢失。继续？")) return;
  setBusy(true);
  try {
    const output = await backend(action, member);
    let detail = "";
    const sessionReport = output.sessions || (output.revocation && output.revocation.sessions) ||
      (action === "revoke-all-sessions" ? output : null);
    if (sessionReport && Array.isArray(sessionReport.terminated) && Array.isArray(sessionReport.manual_review)) {
      detail += "；已终止会话 " + sessionReport.terminated.length +
        " 个，仍需人工复核 " + sessionReport.manual_review.length + " 个";
      if (sessionReport.manual_review.length)
        detail += "（" + sessionReport.manual_review.map(item => item.id + "/" + item.service).join("、") + "）";
    }
    if (output.tokens && typeof output.tokens === "object") {
      detail += "；token 文件 " + output.tokens.token_files_removed +
        " 个，票据文件 " + output.tokens.ticket_files_removed + " 个";
    }
    if (output.docker && typeof output.docker === "object") detail += "；Docker=" + (output.docker.docker || "未知");
    if (typeof output.docker === "string") detail += "；Docker=" + output.docker;
    if (output.account_access) detail += "；账户=" + output.account_access;
    if (output.account_lock) detail += "；账户锁定=" + output.account_lock;
    if ((action === "enable" || action === "recover") && output.result === "PARTIAL") {
      // PARTIAL means the account was NOT enabled end to end: Docker or the
      // credential baseline is incomplete, or the re-lock is unconfirmed.
      detail += "；账户未完成启用";
      if (output.account_lock !== "APPLIED_VERIFIED")
        detail += "，重新锁定未获确认，需人工锁定并核查 /etc/shadow";
    }
    const projects = output.project_memberships || (output.revocation && output.revocation.project_memberships);
    if (projects) {
      detail += "；项目组=" + projects.status;
      if (Array.isArray(projects.failed) && projects.failed.length)
        detail += "；待核查项目=" + projects.failed.join("、");
      if (Array.isArray(projects.manual) && projects.manual.length)
        detail += "；人工处理=" + projects.manual.join("；");
    }
    const steps = output.steps || (output.revocation && output.revocation.steps);
    if (steps) detail += "；步骤：" + Object.entries(steps).map(([key, value]) => key + "=" + value).join("，");
    if (Array.isArray(output.manual) && output.manual.length) detail += "；人工处理：" + output.manual.join("；");
    notice("账户操作结果：" + output.result + detail +
      "。数据和 SSH 公钥保留；登录与授权效果仍须验收。", output.result === "PARTIAL" || output.result === "FAILED" || (output.docker && output.docker.docker === "PARTIAL"));
    await reload();
    await loadAudit();
  } catch (_) {
    notice("账户操作失败或管理员授权不足；操作可能已部分生效，请检查审计、账户、会话和凭据状态。", true);
  } finally {
    setBusy(false);
  }
}

const PASSWORD_LABELS = {
  LOCKED: "已锁定",
  SET: "已设置",
  NO_PASSWORD: "未设置",
  UNKNOWN: "未知"
};

// The backend reports facts it did not read as NOT_INSPECTED; that must never
// read as a healthy state.
function inspected(value) {
  if (typeof value !== "string" || !value || value === "NOT_INSPECTED") return "未检查";
  return value;
}

function renderMemberDetail(panel, name, data) {
  // Only backend text becomes textContent; no HTML is constructed from it.
  const pairs = [
    ["用户名", data.account || name],
    ["UID / GID", (data.uid === undefined ? "未知" : data.uid) + " / " +
      (data.gid === undefined ? "未知" : data.gid)],
    ["HOME", data.home || "未知"],
    ["Shell", data.shell || "未知"],
    ["账号状态", stateLabel(data.state)],
    ["密码状态", PASSWORD_LABELS[data.password] || data.password || "未知"],
    ["Linux 组", Array.isArray(data.groups) && data.groups.length ? data.groups.join("、") : "无"],
    ["Web 登录会话", inspected(data.web_sessions)],
    ["Rootless Docker", inspected(data.rootless_daemon)],
    ["实际文件访问", "未检查"]
  ];
  const list = document.createElement("dl");
  for (const [label, value] of pairs) {
    list.append(node("dt", label), node("dd", value));
  }
  panel.replaceChildren(list);
}

function renderSessions(panel, name, items) {
  if (!items.length) {
    panel.replaceChildren(node("p", "当前没有发现登录会话。", "muted"));
    return;
  }
  const rows = [];
  for (const item of items) {
    const entry = node("div", "", "session-row");
    const service = item.service === "cockpit" ? "Cockpit Web" :
      (item.service === "sshd" ? "SSH" : item.service);
    entry.append(node("span", "#" + item.id + " · " + service +
      " · " + item.type + " · " + item.state));
    if (item.revocable === true) {
      const revoke = node("button", "撤销此会话", "danger session-revoke");
      revoke.addEventListener("click", async () => {
        if (busy || permission.allowed !== true) return;
        const kind = item.service === "sshd" ? "SSH" : "Cockpit Web";
        if (!window.confirm("确认撤销 " + name + " 的 " + kind +
            " 会话 #" + item.id + "？这会终止该会话内的全部进程，可能中断由该会话启动的训练。请先确认 checkpoint 已保存。不会删除容器或工作空间数据。")) return;
        setBusy(true);
        try {
          await backend("revoke-session", name, item.id);
          notice("已撤销 " + kind + " 会话 #" + item.id +
            "。该会话内进程已终止；容器和工作空间数据未删除。");
          await reload();
        } catch (_) {
          notice("撤销失败或尚未确认会话结束。请重新查看会话列表；未执行容器或数据删除。", true);
        } finally {
          setBusy(false);
        }
      });
      entry.append(revoke);
    } else {
      entry.append(node("span", "该服务不支持自动撤销，需人工核查。", "muted"));
    }
    rows.push(entry);
  }
  panel.replaceChildren(...rows);
}

function memberRow(user) {
  const row = node("div", "", "item");
  const details = node("div", "", "info");
  details.append(node("strong", user.name));
  details.append(node("span", "UID " + user.uid +
    " · 状态 " + stateLabel(user.state) +
    " · 口令 " + (user.password || "未知"), "member-meta"));
  row.append(details);
  const actions = node("div", "", "controls");
  // An expanded panel belongs to this row only, so two rows can be open at
  // once and an async answer can never land in another member's card.
  const detailPanel = node("div", "", "member-detail");
  detailPanel.id = "member-detail-" + user.uid;
  detailPanel.hidden = true;
  const view = node("button", "查看详情", "secondary admin-action");
  view.setAttribute("aria-expanded", "false");
  view.setAttribute("aria-controls", detailPanel.id);
  view.addEventListener("click", async () => {
    if (!detailPanel.hidden) {
      detailPanel.hidden = true;
      view.setAttribute("aria-expanded", "false");
      return;
    }
    if (busy || permission.allowed !== true) return;
    setBusy(true);
    try {
      const data = await backend("status", user.name);
      // The list may have been rebuilt while the request was in flight.
      if (!row.isConnected) return;
      renderMemberDetail(detailPanel, user.name, data);
      detailPanel.hidden = false;
      view.setAttribute("aria-expanded", "true");
    } catch (_) {
      if (!row.isConnected) return;
      detailPanel.replaceChildren(node("p", "账户详情读取失败", "muted"));
      detailPanel.hidden = false;
      view.setAttribute("aria-expanded", "true");
    } finally {
      setBusy(false);
    }
  });
  const sessionList = node("div", "", "session-list");
  sessionList.id = "member-sessions-" + user.uid;
  sessionList.hidden = true;
  const sessions = node("button", "查看会话", "secondary admin-action");
  sessions.setAttribute("aria-expanded", "false");
  sessions.setAttribute("aria-controls", sessionList.id);
  sessions.addEventListener("click", async () => {
    if (!sessionList.hidden) {
      sessionList.hidden = true;
      sessions.setAttribute("aria-expanded", "false");
      return;
    }
    if (busy || permission.allowed !== true) return;
    setBusy(true);
    try {
      // Re-read on every expand so a reopened panel never shows stale rows.
      const data = await backend("sessions", user.name);
      // A response without a session list is a failed query, not "none".
      if (!Array.isArray(data.sessions)) throw new Error("Invalid sessions response");
      if (!row.isConnected) return;
      renderSessions(sessionList, user.name, data.sessions);
      sessionList.hidden = false;
      sessions.setAttribute("aria-expanded", "true");
    } catch (_) {
      if (!row.isConnected) return;
      sessionList.replaceChildren(node("p", "会话查询失败；未执行任何撤销操作。", "muted"));
      sessionList.hidden = false;
      sessions.setAttribute("aria-expanded", "true");
    } finally {
      setBusy(false);
    }
  });
  const permissions = node("button", "查看权限", "secondary admin-action");
  permissions.addEventListener("click", async () => {
    if (busy || permission.allowed !== true) return;
    setBusy(true);
    try {
      const data = await backend("permissions", user.name);
      const roles = (data.project_roles || []).map(item => item.project).join("、") || "无";
      notice(user.name + " · 状态 " + data.state +
        " · 平台角色 " + data.platform_role +
        " · 系统管理员授权 " + data.system_admin +
        " · 项目协作者组：" + roles + " · 实际文件访问未检查。");
    } catch (_) { notice("无法读取成员权限；请检查管理员授权与账户状态。", true); }
    finally { setBusy(false); }
  });
  const actionButton = (label, action, className) => {
    const control = node("button", label, (className || "secondary") + " admin-action");
    control.addEventListener("click", () => adminAction(action, user.name));
    return control;
  };
  // The backend re-checks every precondition; this only stops the page from
  // offering an action the account state cannot satisfy, and says why.
  const memberState = user.state || "UNKNOWN";
  const stateKnown = ["ACTIVE", "CREDENTIALS_LOCKED", "DISABLED", "DELETED"].includes(memberState);
  const blocked = [];
  const gatedButton = (label, action, allowed, reason, className) => {
    const control = node("button", label, (className || "secondary") + " admin-action");
    if (allowed) {
      control.blockedReason = "";
      control.addEventListener("click", () => adminAction(action, user.name));
      return control;
    }
    // blockedReason is re-applied by setBusy(), so finishing any other
    // operation cannot turn this control back into a clickable no-op.
    control.blockedReason = reason;
    control.disabled = true;
    control.title = reason;
    blocked.push(label + "（" + reason + "）");
    return control;
  };
  const unknown = "账户状态无法确认，请先人工核查 shadow 状态与登录拒绝情况";
  const disable = gatedButton("停用并撤销", "disable",
    stateKnown && !["DISABLED", "DELETED"].includes(memberState),
    stateKnown ? "账户已停用或已删除，无需再次停用" : unknown, "danger");
  const enable = gatedButton("启用", "enable", memberState === "DISABLED",
    stateKnown ? "仅已停用账户可启用，当前状态为 " + memberState : unknown);
  const softDelete = gatedButton("软删除", "delete", stateKnown && memberState !== "DELETED",
    stateKnown ? "账户已标记删除" : unknown);
  const restore = gatedButton("恢复", "restore", memberState === "DELETED",
    stateKnown ? "仅已软删除账户可恢复，当前状态为 " + memberState : unknown);
  // Soft delete can end PARTIAL and leave live sessions or token files
  // behind. The backend accepts these two remediation actions for a
  // soft-deleted account and verifies ownership, so neither the delete
  // marker nor an unreadable state may hide the way to clean that up.
  const revokeSessions = actionButton("撤销全部会话", "revoke-all-sessions");
  const revokeTokens = actionButton("清理凭据文件", "revoke-tokens");
  if (memberState === "DELETED") {
    revokeSessions.title = "软删除可能残留会话；这是补救入口，只清理本账户的可撤销会话";
    revokeTokens.title = "软删除可能残留 token/票据文件；这是补救入口，只删除本账户私有文件";
  }
  const setupDocker = gatedButton("配置 Rootless Docker", "setup-docker",
    stateKnown && memberState !== "DELETED",
    memberState === "DELETED" ? "已删除账户不可配置容器环境" : unknown);
  if (memberState === "DISABLED") {
    setupDocker.title = "已停用账户仅在存在受控重试标记时允许重新配置，否则后端会拒绝";
  }
  actions.append(view, permissions, sessions, disable, enable,
    softDelete, restore, revokeSessions, revokeTokens, setupDocker);
  row.append(details, actions, detailPanel, sessionList);
  if (blocked.length) row.append(node("p", "当前状态不可用的操作：" + blocked.join("；"), "muted"));
  return row;
}

async function reloadMembers() {
  const result = await backend("list");
  if (!Array.isArray(result.members)) throw new Error("Invalid member list response");
  const users = result.members;
  const container = $a("admin-list");
  container.replaceChildren();
  $a("admin-count").textContent = users.length + " 名成员";
  if (!users.length) container.append(node("p", "尚未创建本平台管理的成员账户。", "muted"));
  for (const user of users) container.append(memberRow(user));
  return users;
}

async function reload() {
  if (permission.allowed !== true) return;
  try {
    await reloadMembers();
  } catch (_) {
    notice("账户列表暂不可用；请确认 Cockpit 已获得管理员授权。", true);
  }
}

async function loadAudit() {
  if (permission.allowed !== true) return;
  const list = $a("audit-list");
  try {
    const result = await backend("audit-log");
    const entries = result.entries || [];
    if (!entries.length) { list.replaceChildren(node("li", "暂无账户管理审计记录。")); return; }
    list.replaceChildren(...entries.slice().reverse().map(item => node("li",
      new Date((item.ts || 0) * 1000).toLocaleString() +
      " · " + (item.action || "未知") +
      " · 操作者 " + (item.actor || "未知") +
      " · 目标 UID " + (item.target_uid === undefined ? "未知" : item.target_uid) +
      (item.target ? " · " + item.target : ""))));
  } catch (_) {
    list.replaceChildren(node("li", "审计记录不可用；请检查管理员授权与审计文件权限。"));
  }
}

function updatePermission() {
  const yes = permission.allowed === true;
  $a("admin-area").hidden = !yes;
  $a("admin-permission").textContent = yes ? "已授权管理员" :
    (permission.allowed === null ? "权限校验中" : "无管理员权限");
  $a("admin-permission").className = "pill " + (yes ? "good" : "fail");
  setBusy(false);
  if (yes) {
    $a("admin-message").className = "feedback";
    $a("admin-message").textContent = "已获系统授权，可管理成员账户；所有操作会写入审计日志。";
    reload();
    loadAudit();
  } else notice("当前登录者无系统管理员授权。页面不可执行账户操作。", true);
}

permission.addEventListener("changed", updatePermission);
$a("admin-refresh").addEventListener("click", () => { reload(); loadAudit(); });
$a("audit-refresh").addEventListener("click", loadAudit);
$a("new-project-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || permission.allowed !== true || !$a("new-project-form").reportValidity()) return;
  const name = $a("new-project-name").value.trim();
  if (!window.confirm("创建项目 " + name + "？现有组 uem-project-" + name + " 的成员将对项目根目录有读写权限。请确认已检查该组全部成员，包括以该组为主组的账户；此操作不会修改成员。")) return;
  setBusy(true);
  try {
    const result = await backend("create-project", name);
    notice("项目目录已创建，对应组：" + result.group + "。成员授权、容器挂载和备份仍需单独处理。");
    $a("new-project-name").value = "";
  } catch (_) {
    notice("创建未完成；请检查项目目录、组和权限。若部分目录已创建，请管理员检查后再处理。", true);
  } finally {
    setBusy(false);
  }
});
$a("project-membership-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || permission.allowed !== true || !$a("project-membership-form").reportValidity()) return;
  const project = $a("membership-project").value.trim();
  const member = $a("membership-member").value.trim();
  setBusy(true);
  try {
    const result = await backend("project-membership", member, project);
    notice(member + " 在当前账户数据库中" + (result.member ? "属于" : "不属于") + result.group +
      (result.primary_group ? "（主组）" : "") + "。未检查实际文件访问、ACL 或已有进程的权限。");
  } catch (_) {
    notice("无法核查项目组关系；请检查成员、项目组及账户数据库。", true);
  } finally { setBusy(false); }
});
async function changeProjectMembership(grant) {
  if (busy || permission.allowed !== true || !$a("project-membership-form").reportValidity()) return;
  const project = $a("membership-project").value.trim();
  const member = $a("membership-member").value.trim();
  const warning = grant ? "授权该成员加入项目组？该组对其他位置的权限也会生效，成员可能读写或删除共享数据。请先核查组用途和成员。" :
    "从项目组移除此成员？旧会话和进程可能仍保留权限，其他组或 ACL 也可能允许访问。不会自动终止训练或删除数据，请单独核查。";
  if (!window.confirm(member + " / " + project + "：" + warning)) return;
  setBusy(true);
  try {
    await backend(grant ? "project-grant" : "project-revoke", member, project);
    notice("项目组记录已更新。已有进程未更改；实际文件访问、ACL 及旧会话权限仍需核查。");
  } catch (_) {
    notice("项目组变更失败或结果未能确认。请管理员先核查组记录及成员实际权限，再决定后续操作。", true);
  } finally { setBusy(false); }
}
$a("grant-membership").addEventListener("click", () => changeProjectMembership(true));
$a("revoke-membership").addEventListener("click", () => changeProjectMembership(false));
// Creation and list refresh are separate stages: a failed refresh must never
// read as a failed creation, and an unconfirmed creation must never invite a
// second `create` call.
function creationOutcome(result, createFailed, members, name) {
  const docker = (result && result.docker) || {};
  const manual = Array.isArray(docker.manual) && docker.manual.length
    ? "；人工处理：" + docker.manual.join("；") : "";
  if (createFailed || !result) {
    const listed = Array.isArray(members) && members.some(item => item.name === name);
    return {
      clearInput: false,
      error: true,
      message: "账户创建结果未能确认（接口异常）；未设置默认密码。" + (members === null
        ? "成员列表也未能刷新，请点击「刷新」检查账户是否已存在，勿直接重复创建。"
        : listed ? "成员列表中已出现该账户，请先核查其状态，勿重复创建。"
        : "成员列表中尚未出现该账户，请刷新确认后再重试。")
    };
  }
  const created = result.result === "created";
  const accountExists = created || result.uid !== null && result.uid !== undefined;
  const account = result.uid === null || result.uid === undefined
    ? "账户状态未确认" : "UID " + result.uid;
  const refresh = members === null ? " 成员列表刷新失败，请点击「刷新」查看最新列表。" : "";
  if (created && docker.docker === "READY") {
    return {
      clearInput: true,
      error: false,
      message: "账户已创建，" + account + "；Docker 配置状态：READY" + manual +
        "。READY 表示本次预检和资源限制探测通过；请设置安全密码，双用户隔离仍需验收。" + refresh
    };
  }
  return {
    clearInput: accountExists,
    error: true,
    message: "账户创建未完成，" + account + "；Docker 配置状态：" +
      (docker.docker || "未知") + manual +
      (accountExists ? "。请处理并核查账户锁定和登录状态，勿设置登录凭据。"
        : "。请先检查是否已创建同名账户，勿设置登录凭据。") + refresh
  };
}

$a("new-member-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || permission.allowed !== true) return;
  if (!$a("new-member-form").reportValidity()) return;
  const name = $a("new-member-name").value.trim();
  if (!window.confirm("创建成员 " + name +
      "？账号初始锁定，系统将尝试配置该成员的 Rootless Docker 并启用 linger，使训练在注销后继续；需要管理员单独设置登录凭据。")) return;
  setBusy(true);
  try {
    let result = null;
    let createFailed = false;
    try {
      result = await backend("create", name);
    } catch (_) {
      createFailed = true;
    }
    let members = null;
    try {
      members = await reloadMembers();
    } catch (_) {
      members = null;
    }
    const outcome = creationOutcome(result, createFailed, members, name);
    notice(outcome.message, outcome.error);
    if (outcome.clearInput) $a("new-member-name").value = "";
  } finally {
    // Re-applies the blockedReason of every state-gated control as well.
    setBusy(false);
  }
});
$a("campus-admin-refresh").addEventListener("click", () => {
  refreshCampusAdmin(true);
});
$a("campus-admin-check").addEventListener("click", async () => {
  if (busy || permission.allowed !== true) return;
  setBusy(true);
  try {
    const result = await campusCall("check-connectivity");
    renderCampusAdmin(result);
    campusNotice(result.state === "CONNECTED"
      ? "外网可达，共享连接仍在使用。"
      : "外网探测失败或状态未确认；这不能证明门户会话已注销，请勿据此直接重新登录。",
      result.state !== "CONNECTED");
  } catch (exc) {
    campusNotice("连通性检查失败：" + (exc && exc.message ? exc.message : "未知错误"), true);
  } finally {
    setBusy(false);
  }
});
$a("campus-admin-recover").addEventListener("click", async () => {
  if (busy || permission.allowed !== true) return;
  const evidence = $a("campus-admin-evidence").value.trim();
  if (evidence.length < 8 || evidence.length > 200) {
    campusNotice("请填写 8–200 字的强制解锁依据，说明如何确认门户会话已结束。", true);
    return;
  }
  if (!window.confirm("强制解锁会允许其他成员重新登录，但代码无法证明旧门户会话已注销。" +
      "仅在门户侧已核实后继续。确认强制解锁？")) return;
  setBusy(true);
  try {
    const result = await campusCall("recover", ["--confirm", "--evidence", evidence]);
    renderCampusAdmin(result);
    $a("campus-admin-evidence").value = "";
    campusNotice("已强制解锁：结果标记为 " + (result.result || "UNVERIFIED") +
      " · 门户会话 " + (result.portal_session || "NOT_VERIFIED") +
      "。请在门户侧再次核实后再允许成员登录。", true);
  } catch (exc) {
    campusNotice("强制解锁失败：" + (exc && exc.message ? exc.message : "未知错误"), true);
  } finally {
    setBusy(false);
  }
});
$a("campus-admin-logout").addEventListener("click", async () => {
  if (busy || permission.allowed !== true) return;
  if (!window.confirm("注销会断开整台工作站的校园网连接，所有成员的下载和镜像拉取都会中断。" +
      "确认注销？")) return;
  setBusy(true);
  try {
    const result = await campusCall("logout", ["--confirm"]);
    renderCampusAdmin(result);
    campusNotice("注销请求已执行：" + (result.result || "结果未知") +
      "。门户会话 " + (result.portal_session || "NOT_VERIFIABLE") +
      "；若未确认，请先在门户侧核实，不要立即让其他成员抢占登录。", true);
  } catch (exc) {
    campusNotice("注销失败：" + (exc && exc.message ? exc.message : "未知错误"), true);
  } finally {
    setBusy(false);
  }
});
if (typeof cockpit.user === "function") {
  cockpit.user().then(user => {
    $a("admin-session").textContent = "管理员账户：" + user.name;
  }).catch(() => {
    $a("admin-session").textContent = "管理员身份由 Cockpit 校验";
  });
}
if (typeof cockpit.logout === "function") {
  $a("admin-logout").addEventListener("click", () => cockpit.logout());
}

refreshCampusAdmin(false);
updatePermission();
