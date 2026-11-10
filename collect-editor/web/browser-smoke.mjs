/* Headless Chromium smoke test of the static browser build. */
import {chromium} from "playwright";

const browser = await chromium.launch({headless: true, args: ["--no-sandbox"]});
const page = await browser.newPage({acceptDownloads: true});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto("http://127.0.0.1:4173/", {waitUntil: "networkidle", timeout: 30000});
  await page.waitForSelector("#fileInput", {state: "attached", timeout: 15000});
  await page.waitForFunction(() => Boolean(window.CollectBrowserAPI), null, {timeout: 15000});
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, {mimeType: "video/webm"});
    const chunks = [];
    recorder.ondataavailable = ({data}) => { if (data.size) chunks.push(data); };
    const completion = new Promise((resolve) => { recorder.onstop = resolve; });
    let tick = 0;
    const draw = () => {
      context.fillStyle = tick++ % 2 ? "#a88cff" : "#172d48";
      context.fillRect(0, 0, 160, 90);
    };
    draw();
    const frameTimer = setInterval(draw, 50);
    recorder.start(100);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    recorder.stop();
    await completion;
    clearInterval(frameTimer);
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, {type: "video/webm"});
    const file = new File([blob], "collect-smoke.webm", {type: "video/webm"});
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById("fileInput");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", {bubbles: true}));
    return {size: blob.size};
  });
  console.log("Generated browser video bytes:", result.size);
  if (!result.size) throw Error("Generated source video is empty");

  await page.waitForFunction(
    () => document.getElementById("mediaCount").textContent === "1",
    null, {timeout: 30000}
  );
  await page.locator(".media-item .add-button").click();
  await page.waitForFunction(
    () => document.getElementById("timelineCount").textContent.includes("1 clip"),
    null, {timeout: 10000}
  );

  await page.locator("#exportButton").click();
  await page.locator("#resolution").selectOption("360p");
  await page.locator("#startExport").click();

  const outcome = await Promise.race([
    page.waitForFunction(
      () => !document.getElementById("downloadExport").hidden,
      null, {timeout: 240000}
    ).then(() => "complete"),
    page.waitForFunction(
      () => /error|failed|invalid|unsupported/i.test(document.getElementById("exportMessage")?.textContent || ""),
      null, {timeout: 240000}
    ).then(() => "error")
  ]);
  if (outcome !== "complete") {
    throw Error("Export failed: " + (await page.locator("#exportMessage").textContent()));
  }
  const href = await page.locator("#downloadExport").getAttribute("href");
  if (!href?.startsWith("blob:")) throw Error("Export must produce a local Blob download URL");
  const size = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return (await response.blob()).size;
  }, href);
  if (size < 1000) throw Error("MP4 export is empty");
  console.log("PASS: imported a local clip, edited the timeline and exported MP4 bytes:", size);
} catch (error) {
  console.error("Browser errors:", errors.slice(-15));
  console.error("Export status:", await page.locator("#exportMessage").textContent().catch(() => "unknown"));
  throw error;
} finally {
  await browser.close();
}
