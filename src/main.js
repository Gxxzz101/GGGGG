const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".html",
  ".css",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".log"
]);

const EXTENSION_CATEGORIES = [
  { folder: "Documents", extensions: [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt", ".md"] },
  { folder: "Images", extensions: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".svg"] },
  { folder: "Videos", extensions: [".mp4", ".mov", ".mkv", ".avi", ".webm"] },
  { folder: "Audio", extensions: [".mp3", ".wav", ".m4a", ".aac", ".flac"] },
  { folder: "Code", extensions: [".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rs", ".html", ".css"] },
  { folder: "Archives", extensions: [".zip", ".rar", ".7z", ".tar", ".gz"] }
];

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "AI File Organizer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("folder:choose", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "选择需要整理的文件夹"
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("folder:scan", async (_event, folderPath) => {
  assertSafeFolder(folderPath);
  const files = await scanFolder(folderPath);
  const plan = await buildOrganizationPlan(folderPath, files);
  return {
    folderPath,
    provider: process.env.OPENAI_API_KEY ? "openai" : "local-rules",
    files,
    plan
  };
});

ipcMain.handle("plan:execute", async (_event, { folderPath, plan }) => {
  assertSafeFolder(folderPath);
  return executePlan(folderPath, plan);
});

function assertSafeFolder(folderPath) {
  if (!folderPath || typeof folderPath !== "string" || !path.isAbsolute(folderPath)) {
    throw new Error("请选择一个有效的绝对路径文件夹。");
  }
}

async function scanFolder(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const absolutePath = path.join(folderPath, entry.name);
    const stats = await fs.stat(absolutePath);
    const extension = path.extname(entry.name).toLowerCase();

    files.push({
      id: stableId(absolutePath),
      name: entry.name,
      extension,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      preview: await readPreview(absolutePath, extension)
    });
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function readPreview(filePath, extension) {
  if (!TEXT_EXTENSIONS.has(extension)) {
    return "";
  }

  try {
    const handle = await fs.open(filePath, constants.O_RDONLY);
    const buffer = Buffer.alloc(4000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    await handle.close();
    return buffer.subarray(0, bytesRead).toString("utf8").replace(/\0/g, "").trim();
  } catch {
    return "";
  }
}

async function buildOrganizationPlan(folderPath, files) {
  const localPlan = buildLocalPlan(files);

  if (!process.env.OPENAI_API_KEY || files.length === 0) {
    return localPlan;
  }

  try {
    const aiPlan = await buildAiPlan(files);
    return mergePlans(localPlan, aiPlan);
  } catch (error) {
    return localPlan.map((item) => ({
      ...item,
      warning: `AI 分类失败，已使用本地规则：${error.message}`
    }));
  }
}

function buildLocalPlan(files) {
  return files.map((file) => {
    const category = categoryForExtension(file.extension);
    const month = file.modifiedAt.slice(0, 7);
    const folder = category === "Review" ? "Review" : path.join(category, month);

    return {
      fileId: file.id,
      sourceName: file.name,
      targetFolder: folder,
      targetName: file.name,
      confidence: category === "Review" ? 0.42 : 0.72,
      reason: category === "Review" ? "无法仅根据扩展名可靠分类，建议人工检查。" : `根据扩展名 ${file.extension || "无扩展名"} 归类。`
    };
  });
}

function categoryForExtension(extension) {
  for (const group of EXTENSION_CATEGORIES) {
    if (group.extensions.includes(extension)) {
      return group.folder;
    }
  }
  return "Review";
}

async function buildAiPlan(files) {
  const payload = files.slice(0, 80).map((file) => ({
    id: file.id,
    name: file.name,
    extension: file.extension,
    size: file.size,
    modifiedAt: file.modifiedAt,
    preview: file.preview.slice(0, 900)
  }));

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.2",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You organize user files into clear folders.",
                "Return only JSON with an items array.",
                "Each item must include fileId, targetFolder, targetName, confidence, reason.",
                "Use safe short folder names. Do not suggest deleting files.",
                "Put uncertain files under Review."
              ].join(" ")
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({ files: payload })
            }
          ]
        }
      ],
      max_output_tokens: 6000
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.output_text || extractOutputText(data);
  const parsed = JSON.parse(stripCodeFence(text));

  if (!Array.isArray(parsed.items)) {
    throw new Error("AI 返回格式缺少 items 数组。");
  }

  return parsed.items;
}

function extractOutputText(data) {
  const chunks = [];
  for (const output of data.output || []) {
    for (const content of output.content || []) {
      if (content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n");
}

function stripCodeFence(text) {
  return text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

function mergePlans(localPlan, aiPlan) {
  const localById = new Map(localPlan.map((item) => [item.fileId, item]));
  const merged = [];

  for (const localItem of localPlan) {
    const aiItem = aiPlan.find((item) => item.fileId === localItem.fileId);
    if (!aiItem) {
      merged.push(localItem);
      continue;
    }

    merged.push({
      ...localItem,
      targetFolder: sanitizeRelativeFolder(aiItem.targetFolder || localItem.targetFolder),
      targetName: sanitizeFileName(aiItem.targetName || localItem.targetName),
      confidence: normalizeConfidence(aiItem.confidence, localItem.confidence),
      reason: aiItem.reason || localItem.reason
    });
  }

  for (const item of aiPlan) {
    if (!localById.has(item.fileId)) {
      continue;
    }
  }

  return merged;
}

async function executePlan(folderPath, plan) {
  const results = [];

  for (const item of plan) {
    const sourcePath = path.join(folderPath, item.sourceName);
    const targetFolder = path.resolve(folderPath, sanitizeRelativeFolder(item.targetFolder));
    const rootPath = path.resolve(folderPath);
    if (!targetFolder.startsWith(rootPath + path.sep) && targetFolder !== rootPath) {
      throw new Error(`目标路径不安全：${item.targetFolder}`);
    }

    await fs.mkdir(targetFolder, { recursive: true });

    const targetPath = await nextAvailablePath(targetFolder, sanitizeFileName(item.targetName));
    await fs.rename(sourcePath, targetPath);

    results.push({
      sourceName: item.sourceName,
      targetPath,
      status: "moved"
    });
  }

  return results;
}

async function nextAvailablePath(folderPath, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(folderPath, fileName);
  let index = 1;

  while (await exists(candidate)) {
    candidate = path.join(folderPath, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }

  return candidate;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeRelativeFolder(value) {
  const cleaned = String(value || "Review")
    .split(/[\\/]+/)
    .map((part) => sanitizeFileName(part))
    .filter((part) => part && part !== "." && part !== "..")
    .join(path.sep);

  return cleaned || "Review";
}

function sanitizeFileName(value) {
  return String(value || "untitled")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "untitled";
}

function normalizeConfidence(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, number));
}

function stableId(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
