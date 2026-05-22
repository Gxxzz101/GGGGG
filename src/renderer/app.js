const state = {
  folderPath: null,
  files: [],
  plan: [],
  provider: "-",
  filter: "all"
};

const chooseFolderButton = document.querySelector("#chooseFolderButton");
const scanButton = document.querySelector("#scanButton");
const executeButton = document.querySelector("#executeButton");
const folderPathEl = document.querySelector("#folderPath");
const fileCountEl = document.querySelector("#fileCount");
const providerNameEl = document.querySelector("#providerName");
const reviewCountEl = document.querySelector("#reviewCount");
const statusTextEl = document.querySelector("#statusText");
const planTableBody = document.querySelector("#planTableBody");
const confirmDialog = document.querySelector("#confirmDialog");

chooseFolderButton.addEventListener("click", async () => {
  setStatus("正在打开文件夹选择器...");
  const folderPath = await window.organizer.chooseFolder();
  if (!folderPath) {
    setStatus("未选择文件夹。");
    return;
  }

  state.folderPath = folderPath;
  state.files = [];
  state.plan = [];
  state.provider = "-";
  folderPathEl.textContent = folderPath;
  scanButton.disabled = false;
  executeButton.disabled = true;
  render();
  setStatus("已选择文件夹，可以开始扫描。");
});

scanButton.addEventListener("click", async () => {
  if (!state.folderPath) {
    return;
  }

  scanButton.disabled = true;
  executeButton.disabled = true;
  setStatus("正在扫描文件并生成整理计划...");

  try {
    const result = await window.organizer.scanFolder(state.folderPath);
    state.files = result.files;
    state.plan = result.plan;
    state.provider = result.provider;
    executeButton.disabled = state.plan.length === 0;
    setStatus(state.plan.length > 0 ? "整理计划已生成，请检查后执行。" : "这个文件夹中没有可整理的文件。");
  } catch (error) {
    setStatus(error.message || "扫描失败。");
  } finally {
    scanButton.disabled = false;
    render();
  }
});

executeButton.addEventListener("click", async () => {
  if (!state.folderPath || state.plan.length === 0) {
    return;
  }

  const result = await openConfirmDialog();
  if (result !== "confirm") {
    return;
  }

  executeButton.disabled = true;
  scanButton.disabled = true;
  setStatus("正在移动文件...");

  try {
    const results = await window.organizer.executePlan(state.folderPath, state.plan);
    state.files = [];
    state.plan = [];
    setStatus(`整理完成，已移动 ${results.length} 个文件。`);
  } catch (error) {
    setStatus(error.message || "执行整理失败。");
  } finally {
    scanButton.disabled = false;
    render();
  }
});

document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".filter-button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    renderPlan();
  });
});

function openConfirmDialog() {
  return new Promise((resolve) => {
    confirmDialog.addEventListener(
      "close",
      () => {
        resolve(confirmDialog.returnValue);
      },
      { once: true }
    );
    confirmDialog.showModal();
  });
}

function render() {
  fileCountEl.textContent = String(state.files.length);
  providerNameEl.textContent = state.provider === "openai" ? "AI" : state.provider === "local-rules" ? "规则" : "-";
  reviewCountEl.textContent = String(state.plan.filter((item) => item.targetFolder.startsWith("Review") || item.confidence < 0.55).length);
  renderPlan();
}

function renderPlan() {
  const rows = filteredPlan();

  if (rows.length === 0) {
    planTableBody.innerHTML = `<tr class="empty-row"><td colspan="4">${state.plan.length === 0 ? "暂无整理计划" : "当前筛选下没有文件"}</td></tr>`;
    return;
  }

  planTableBody.innerHTML = rows
    .map((item) => {
      const lowConfidence = item.confidence < 0.55;
      return `
        <tr>
          <td><div class="file-name">${escapeHtml(item.sourceName)}</div></td>
          <td><span class="target">${escapeHtml(item.targetFolder)}/${escapeHtml(item.targetName)}</span></td>
          <td><span class="confidence ${lowConfidence ? "low" : ""}">${Math.round(item.confidence * 100)}%</span></td>
          <td>${escapeHtml(item.warning || item.reason || "")}</td>
        </tr>
      `;
    })
    .join("");
}

function filteredPlan() {
  if (state.filter === "review") {
    return state.plan.filter((item) => item.targetFolder.startsWith("Review") || item.confidence < 0.55);
  }

  if (state.filter === "ready") {
    return state.plan.filter((item) => !item.targetFolder.startsWith("Review") && item.confidence >= 0.55);
  }

  return state.plan;
}

function setStatus(message) {
  statusTextEl.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
