/* global Buffer, console, process, setTimeout, WebSocket */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const [cdpUrl, origin = "http://localhost:3000"] = process.argv.slice(2);
if (!cdpUrl) {
  throw new Error("usage: node scripts/verify-documents-matrix.mjs <cdp-url> [origin]");
}

const outputDir = "/tmp/chaste-documents-matrix";
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const socket = new WebSocket(cdpUrl);
const pending = new Map();
let nextId = 1;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

function command(method, params = {}, sessionId) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const { targetInfos } = await command("Target.getTargets");
const target = targetInfos.find((item) => item.type === "page" && item.url.startsWith(origin));
if (!target) throw new Error(`no authenticated browser page found at ${origin}`);
const { sessionId } = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
await command("Page.enable", {}, sessionId);
await command("Runtime.enable", {}, sessionId);

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function browserRequest(path, init = {}) {
  const response = await evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, ${JSON.stringify(init)});
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  })()`);
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function ensureFolder(path) {
  try {
    await browserRequest("/api/docs/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", path }),
    });
  } catch (error) {
    if (!String(error).includes("already exists")) throw error;
  }
}

async function waitForDocument(marker) {
  let lastState = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await evaluate(`({
      ready: document.readyState,
      preview: document.querySelector(".document-paper")?.textContent?.includes(${JSON.stringify(marker)}) ?? false,
      print: document.querySelector(".print-only")?.textContent?.includes(${JSON.stringify(marker)}) ?? false,
      error: document.body?.innerText.includes("Document not found") ?? false
    })`);
    lastState = state;
    if (state.error) throw new Error("editor reported Document not found");
    if (state.ready === "complete" && state.preview && state.print) return;
    await sleep(100);
  }
  throw new Error(`editor preview did not render ${marker}; last state: ${JSON.stringify(lastState)}`);
}

function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function typeFromName(name) {
  const prefix = name.split(" - ")[0].toLowerCase();
  return prefix === "sales invoice" ? "sales_invoice"
    : prefix === "purchase order" ? "purchase_order"
      : prefix === "delivery note" ? "delivery_note"
        : prefix === "employment contract" ? "employment_contract"
          : prefix === "employment agreement" ? "employment_agreement"
            : prefix;
}

const expectedPrefixes = [
  "Quotation",
  "Receipt",
  "Sales invoice",
  "Purchase order",
  "Voucher",
  "Delivery note",
  "Employment contract",
  "Employment agreement",
];
const runId = Date.now();
const rootFolder = `QA Matrix ${runId}`;
const createdIds = [];
const evidence = [];

try {
  const catalog = await browserRequest("/api/docs");
  const templates = catalog.templates.filter((template) =>
    expectedPrefixes.some((prefix) => template.name.startsWith(`${prefix} - `)),
  );
  if (templates.length !== 24) throw new Error(`expected 24 professional templates, found ${templates.length}`);

  const counts = new Map(expectedPrefixes.map((prefix) => [prefix, 0]));
  for (const template of templates) {
    const prefix = expectedPrefixes.find((candidate) => template.name.startsWith(`${candidate} - `));
    counts.set(prefix, counts.get(prefix) + 1);
  }
  for (const [prefix, count] of counts) {
    if (count !== 3) throw new Error(`${prefix} has ${count} templates, expected 3`);
  }

  for (const [index, template] of templates.entries()) {
    const marker = `Matrix proof ${String(index + 1).padStart(2, "0")} ${runId}`;
    const detail = await browserRequest(`/api/docs?template=${template.id}`);
    const content = JSON.parse(JSON.stringify(detail.template.content).replace(/\{\{[^}]+\}\}/g, "Verified business value"));
    content.content.push({ type: "paragraph", content: [{ type: "text", text: marker }] });
    const documentType = typeFromName(template.name);
    const folder = `${rootFolder}/${documentType}`;
    const title = `QA ${template.name} ${runId}`;
    const pageSettings = {
      size: index % 2 === 0 ? "A4" : "Letter",
      orientation: index % 3 === 0 ? "landscape" : "portrait",
      margin: ["compact", "normal", "wide"][index % 3],
    };

    await ensureFolder(folder);
    const created = await browserRequest("/api/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create",
        title,
        content,
        html: `<p>${marker}</p>`,
        templateId: template.id,
        documentType,
        pageSettings,
      }),
    });
    const documentId = created.documentId ?? created.document?.id;
    if (!documentId) throw new Error(`${template.name} did not return a document id: ${JSON.stringify(created)}`);
    createdIds.push(documentId);

    const saved = await browserRequest(`/api/docs/${documentId}/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, pageSettings }),
    });
    if (!saved.savedRev) throw new Error(`${template.name} did not save a draft revision`);
    const reopened = await browserRequest(`/api/docs/${documentId}/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (JSON.stringify(reopened.draft?.content).includes(marker) === false) {
      throw new Error(`${template.name} draft did not reopen with its saved marker`);
    }

    await browserRequest(`/api/docs/${documentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "updateMetadata", title, folder }),
    });
    await browserRequest(`/api/docs/${documentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "publish",
        title,
        content,
        html: `<p>${marker}</p>`,
        note: "24-template browser and PDF matrix",
        pageSettings,
      }),
    });
    const persisted = await browserRequest(`/api/docs/${documentId}`);
    if (persisted.document?.folder !== folder || persisted.document?.title !== title) {
      throw new Error(`${template.name} did not persist its title and folder`);
    }
    if (!JSON.stringify(persisted.document?.content).includes(marker) || persisted.versions?.length !== 1) {
      throw new Error(`${template.name} did not persist its published content and version`);
    }

    // Dev servers recompile routes on navigation; a slow filesystem can stall
    // the route loader past any single wait. Re-navigate a bounded number of
    // times before giving up.
    let rendered = false;
    for (let attempt = 0; attempt < 3 && !rendered; attempt += 1) {
      await command("Page.navigate", { url: `${origin}/documents/editor/${documentId}` }, sessionId);
      try {
        await waitForDocument(marker);
        rendered = true;
      } catch (error) {
        if (attempt === 2 || !String(error).includes("did not render")) throw error;
      }
    }
    if (!rendered) throw new Error(`${template.name} editor never rendered its marker`);
    await command("Emulation.setEmulatedMedia", { media: "print" }, sessionId);
    const { data } = await command("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    }, sessionId);
    await command("Emulation.setEmulatedMedia", { media: "screen" }, sessionId);
    const pdfPath = `${outputDir}/${String(index + 1).padStart(2, "0")}-${safeName(template.name)}.pdf`;
    await writeFile(pdfPath, Buffer.from(data, "base64"));
    const [{ stdout: text }, { stdout: info }] = await Promise.all([
      execFileAsync("pdftotext", [pdfPath, "-"]),
      execFileAsync("pdfinfo", [pdfPath]),
    ]);
    if (!text.includes(marker)) throw new Error(`${template.name} PDF did not contain its saved marker`);
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    if (pages < 1) throw new Error(`${template.name} PDF had no pages`);
    evidence.push({ name: template.name, type: documentType, pages, pdfPath });

    await browserRequest(`/api/docs/${documentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete" }),
    });
    createdIds.pop();
    console.log(`VERIFIED ${index + 1}/24: ${template.name} (${pages} page${pages === 1 ? "" : "s"})`);
  }
} finally {
  for (const documentId of createdIds.reverse()) {
    await browserRequest(`/api/docs/${documentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete" }),
    }).catch(() => undefined);
  }
  const folders = await browserRequest("/api/docs/folders").catch(() => ({ folders: [] }));
  const paths = (folders.folders ?? [])
    .map((folder) => folder.path)
    .filter((path) => path === rootFolder || path.startsWith(`${rootFolder}/`))
    .sort((left, right) => right.split("/").length - left.split("/").length);
  for (const path of paths) {
    await browserRequest("/api/docs/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", path }),
    }).catch(() => undefined);
  }
  await command("Page.navigate", { url: `${origin}/documents/write` }, sessionId).catch(() => undefined);
  socket.close();
}

const perType = Object.fromEntries(expectedPrefixes.map((prefix) => [
  typeFromName(`${prefix} - sample`),
  evidence.filter((item) => item.type === typeFromName(`${prefix} - sample`)).length,
]));
console.log(`DOCUMENT MATRIX OK: ${evidence.length} templates verified (${JSON.stringify(perType)})`);
