/* global process, WebSocket, Buffer, console */
import { writeFile } from "node:fs/promises";

const [cdpUrl, outputPath, urlFragment = "/documents/editor/"] = process.argv.slice(2);
if (!cdpUrl || !outputPath) throw new Error("usage: node scripts/verify-documents-pdf.mjs <cdp-url> <output.pdf> [url-fragment]");

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

const { targetInfos } = await command("Target.getTargets");
const target = targetInfos.find((item) => item.type === "page" && item.url.includes(urlFragment));
if (!target) throw new Error(`no browser page matched ${urlFragment}`);
const { sessionId } = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
await command("Page.enable", {}, sessionId);
await command("Emulation.setEmulatedMedia", { media: "print" }, sessionId);
const { data } = await command("Page.printToPDF", {
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: false,
}, sessionId);
await writeFile(outputPath, Buffer.from(data, "base64"));
await command("Emulation.setEmulatedMedia", { media: "screen" }, sessionId);
socket.close();
console.log(`DOCUMENT PDF OK: ${outputPath}`);
