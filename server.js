#!/usr/bin/env node
const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT = 4000;

// 일반 모델: POST → 전체 WAV 반환
const MODELS = {
  "qwen3-stream": {
    label: "Qwen3-TTS · streaming (80ms TTFA)",
    streaming: true,
    url: "http://127.0.0.1:5051/speak/stream",
    body: (text) => ({
      text, language: "korean", seed: 20260526,
      temperature: 0.7, top_k: 50,
      instruct: "Speak clearly with a neutral tone.",
    }),
  },
  "qwen3-sohee": {
    label: "Qwen3-TTS · sohee",
    url: "http://127.0.0.1:5051/speak",
    body: (text) => ({ text, language: "korean", engine: "qwen3", speaker: "sohee", seed: 20260526 }),
  },
  "qwen3-clone": {
    label: "Qwen3-TTS · voice clone",
    url: "http://127.0.0.1:5051/speak",
    body: (text) => ({ text, language: "korean", engine: "qwen3", seed: 20260526 }),
  },
  "cosyvoice-mlx": {
    label: "CosyVoice3 · MLX",
    url: "http://127.0.0.1:5051/speak",
    body: (text) => ({ text, language: "korean", engine: "cosyvoice", seed: 20260526 }),
  },
  "cosyvoice-pytorch": {
    label: "CosyVoice3 · PyTorch",
    url: "http://127.0.0.1:5050",
    body: (text) => ({ text, speed: 1.0 }),
  },
};

// 쉼표/마침표 등 구두점을 제거해 TTS 모델의 한숨/긴침묵 방지
function cleanText(text) {
  return text.replace(/,/g, " ").replace(/  +/g, " ").trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.end();

  // GET /models
  if (u.pathname === "/models" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(
      Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, streaming: !!m.streaming }))
    ));
  }

  // POST /tts/stream?model=xxx — raw PCM16 24kHz streaming proxy
  if (u.pathname === "/tts/stream" && req.method === "POST") {
    const modelId = u.searchParams.get("model");
    const model = MODELS[modelId];
    if (!model?.streaming) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Not a streaming model" }));
    }
    try {
      const { text } = await readBody(req);
      if (!text?.trim()) { res.statusCode = 400; return res.end(JSON.stringify({ error: "text 필요" })); }
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 60000);
      let ttsRes;
      try {
        ttsRes = await fetch(model.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(model.body(cleanText(text))),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!ttsRes.ok) {
        res.statusCode = 502;
        return res.end(JSON.stringify({ error: `TTS 오류 ${ttsRes.status}` }));
      }
      res.setHeader("Content-Type", "audio/pcm");
      res.setHeader("X-Sample-Rate", "24000");
      res.setHeader("Transfer-Encoding", "chunked");
      // Pipe stream through
      const reader = ttsRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    } catch (e) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // POST /tts?model=xxx
  if (u.pathname === "/tts" && req.method === "POST") {
    const modelId = u.searchParams.get("model");
    const model = MODELS[modelId];
    if (!model) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: `Unknown model: ${modelId}` }));
    }
    try {
      const { text } = await readBody(req);
      if (!text?.trim()) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "text 필요" }));
      }
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 60000);
      let ttsRes;
      const ttsStart = Date.now();
      try {
        ttsRes = await fetch(model.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(model.body(cleanText(text))),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      const ttsMs = Date.now() - ttsStart;
      if (!ttsRes.ok) {
        res.statusCode = 502;
        return res.end(JSON.stringify({ error: `TTS 오류 ${ttsRes.status}` }));
      }
      const audio = Buffer.from(await ttsRes.arrayBuffer());
      res.setHeader("Content-Type", ttsRes.headers.get("content-type") || "audio/wav");
      res.setHeader("Content-Length", audio.length);
      res.setHeader("X-Tts-Ms", ttsMs);
      return res.end(audio);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Static
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(fs.readFileSync(path.join(__dirname, "index.html")));

}).listen(PORT, "0.0.0.0", () => {
  console.log(`TTS 비교 서버: http://localhost:${PORT}`);
  console.log(`Tailscale:     http://100.88.122.15:${PORT}`);
});
