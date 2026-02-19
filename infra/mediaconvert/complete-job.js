/* eslint-disable no-console */
const https = require("https");
const { URL } = require("url");

const BACKEND_WEBHOOK_URL = process.env.BACKEND_WEBHOOK_URL;
const MEDIA_PIPELINE_SECRET = process.env.MEDIA_PIPELINE_SECRET;
const MEDIA_CDN_BASE = (process.env.MEDIA_CDN_BASE || "").replace(/\/+$/, "");

if (!BACKEND_WEBHOOK_URL || !MEDIA_PIPELINE_SECRET || !MEDIA_CDN_BASE) {
  throw new Error("BACKEND_WEBHOOK_URL, MEDIA_PIPELINE_SECRET, MEDIA_CDN_BASE are required");
}

const postJson = (url, payload) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-media-secret": MEDIA_PIPELINE_SECRET,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

exports.handler = async (event) => {
  const detail = event.detail || {};
  const status = detail.status;
  if (status !== "COMPLETE") return;

  const metadata = detail.userMetadata || {};
  const s3Key = metadata.s3Key;
  const outputPrefix = metadata.outputPrefix;
  if (!s3Key || !outputPrefix) return;

  const manifestPath = `${outputPrefix}index.m3u8`.replace(/^\/+/, "");
  const hlsUrl = `${MEDIA_CDN_BASE}/${manifestPath}`;

  const response = await postJson(BACKEND_WEBHOOK_URL, {
    s3Key,
    hlsUrl,
  });

  console.log("HLS complete webhook", response);
};
