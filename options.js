const STATE_FIELDS = ["mode", "direction", "groupStrategy", "folderFirst", "recursive"];

const $ = id => document.getElementById(id);

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

function send(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, reason: "no-response" });
    });
  });
}

function readForm() {
  return {
    mode: $("mode").value,
    direction: $("direction").value,
    groupStrategy: $("groupStrategy").value,
    folderFirst: $("folderFirst").checked,
    recursive: $("recursive").checked
  };
}

function fillForm(options) {
  STATE_FIELDS.forEach(key => {
    const el = $(key);
    if (!el) return;
    if (el.type === "checkbox") el.checked = Boolean(options[key]);
    else el.value = options[key];
  });
  syncVisibility();
}

// 混合排序时「文件夹位置」无意义
function syncVisibility() {
  const separate = $("groupStrategy").value === "separate";
  $("folderFirstRow").style.display = separate ? "" : "none";
}

function renderSnapshots(count) {
  $("snapCount").textContent = String(count || 0);
  $("btnRestore").disabled = !count;
  $("btnClear").disabled = !count;
}

async function refresh() {
  const state = await send({ type: "get_state" });
  if (!state.ok) {
    setStatus(`读取设置失败：${state.reason}`, "err");
    return;
  }
  fillForm(state.options);
  renderSnapshots(state.snapshotCount);
}

async function guard(button, pendingText, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  try {
    await task();
  } finally {
    button.textContent = original;
    await refresh();
  }
}

$("form").addEventListener("submit", async event => {
  event.preventDefault();
  const result = await send({ type: "save_options", options: readForm() });
  if (result.ok) setStatus("设置已保存 ✓", "ok");
  else setStatus(`保存失败：${result.reason}`, "err");
});

$("groupStrategy").addEventListener("change", syncVisibility);

$("btnSort").addEventListener("click", event => {
  const button = event.currentTarget;
  guard(button, "排序中…", async () => {
    // 排序使用已保存的配置，避免用户改了未保存就执行
    await send({ type: "save_options", options: readForm() });
    const result = await send({ type: "sort_all" });
    if (result.ok) setStatus("排序完成 ✓", "ok");
    else setStatus(`未完成：${result.reason}`, "err");
  });
});

$("btnRestore").addEventListener("click", event => {
  const button = event.currentTarget;
  guard(button, "恢复中…", async () => {
    const result = await send({ type: "restore" });
    if (result.ok) {
      const suffix = result.skipped ? `（跳过 ${result.skipped} 个失效文件夹）` : "";
      setStatus(`已恢复 ${result.restored} 个文件夹${suffix} ✓`, "ok");
    } else {
      setStatus(`未完成：${result.reason}`, "err");
    }
  });
});

$("btnClear").addEventListener("click", event => {
  const button = event.currentTarget;
  guard(button, "清理中…", async () => {
    const result = await send({ type: "clear_history" });
    if (result.ok) setStatus("历史快照已清空（此操作不可撤销）", "ok");
    else setStatus(`清理失败：${result.reason}`, "err");
  });
});

refresh();
