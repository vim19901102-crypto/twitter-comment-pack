/**
 * HTTP API service for n8n/VPS usage.
 * Uses Twitter/X web cookies from data/config.json, not the official Twitter API.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.mjs';
import { generateComment } from './lib/ai-commenter.mjs';
import { postTweet } from './lib/twitter-http.mjs';
import { detectLanguage } from './lib/language.mjs';
import { initStore, markCommented } from './lib/store.mjs';
import { runWarmup } from './warmup.mjs';

const PORT = Number(process.env.PORT || process.env.API_PORT || 3009);
const HOST = process.env.HOST || '0.0.0.0';
const API_TOKEN = process.env.API_SERVICE_TOKEN || process.env.N8N_API_TOKEN || '';
const MAX_BODY_BYTES = Number(process.env.API_MAX_BODY_BYTES || 1024 * 1024);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function requireToken(req) {
  if (!API_TOKEN) return true;
  const auth = req.headers.authorization || '';
  const apiKey = req.headers['x-api-key'] || '';
  return auth === `Bearer ${API_TOKEN}` || apiKey === API_TOKEN;
}

function cleanText(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${fieldName} is required`);
  return text;
}

function parseTweetId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const statusMatch = raw.match(/\/status(?:es)?\/(\d+)/);
  if (statusMatch) return statusMatch[1];
  const idMatch = raw.match(/\b(\d{10,25})\b/);
  return idMatch ? idMatch[1] : '';
}

function normalizePath(filePath) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function accountEntries(accounts) {
  if (!accounts) return [];
  if (Array.isArray(accounts)) return accounts;
  return Object.entries(accounts).map(([id, value]) => ({
    id,
    ...(typeof value === 'string' ? { cookiesFile: value } : value),
  }));
}

function resolveCookiesFile(cfg, body) {
  const accountId = String(body.accountId || body.id_taikhoan || body.account || '').trim();
  if (accountId) {
    const account = accountEntries(cfg.accounts).find((item) => {
      return String(item.id || item.accountId || item.id_taikhoan || '').trim() === accountId;
    });
    if (!account) throw new Error(`Unknown accountId: ${accountId}`);
    if (!account.cookiesFile) throw new Error(`cookiesFile missing for accountId: ${accountId}`);
    const cookiesFile = normalizePath(account.cookiesFile);
    if (!fs.existsSync(cookiesFile)) throw new Error(`Cookies file not found: ${cookiesFile}`);
    return { accountId, cookiesFile };
  }

  const cookiesFile = normalizePath(cfg.cookiesFile);
  if (!fs.existsSync(cookiesFile)) throw new Error(`Cookies file not found: ${cookiesFile}`);
  return { accountId: 'default', cookiesFile };
}

function requestContext(cfg, body) {
  const { accountId, cookiesFile } = resolveCookiesFile(cfg, body);
  return {
    accountId,
    cookiesFile,
    style: String(body.style || body.stylePrompt || cfg.modeA?.stylePrompt || '').trim(),
    lang: String(body.lang || body.language || cfg.modeA?.language || 'auto').trim(),
  };
}

async function handlePost(cfg, body) {
  const ctx = requestContext(cfg, body);
  const text = cleanText(body.text || body.content || body.caption, 'text');
  const tweetId = await postTweet(text, ctx.cookiesFile);
  return {
    ok: true,
    action: 'post',
    accountId: ctx.accountId,
    tweetId,
    url: tweetId === 'ok' ? null : `https://x.com/i/web/status/${tweetId}`,
  };
}

async function handleComment(cfg, body) {
  const ctx = requestContext(cfg, body);
  const tweetId = parseTweetId(body.tweetId || body.replyToId || body.tweetUrl || body.url || body.link);
  if (!tweetId) throw new Error('tweetId or tweetUrl is required');
  const text = cleanText(body.text || body.comment || body.content, 'text');
  const replyId = await postTweet(text, ctx.cookiesFile, { replyToId: tweetId });
  markCommented(tweetId, body.author || '');
  return {
    ok: true,
    action: 'comment',
    accountId: ctx.accountId,
    tweetId,
    replyId,
    url: replyId === 'ok' ? null : `https://x.com/i/web/status/${replyId}`,
  };
}

async function handleAiComment(cfg, body) {
  const ctx = requestContext(cfg, body);
  const tweetId = parseTweetId(body.tweetId || body.replyToId || body.tweetUrl || body.url || body.link);
  if (!tweetId) {
    await runWarmup({ ...cfg, cookiesFile: ctx.cookiesFile }, false);
    return {
      ok: true,
      action: 'ai-comment',
      mode: 'warmup',
      accountId: ctx.accountId,
    };
  }

  const tweetText = cleanText(
    body.tweetText || body.targetText || body.sourceText || body.postText,
    'tweetText',
  );
  const lang = ctx.lang === 'auto' ? detectLanguage(tweetText) : ctx.lang;
  const comment = await generateComment({
    tweetText,
    lang,
    style: ctx.style,
    ai: cfg.ai,
  });
  const replyId = await postTweet(comment, ctx.cookiesFile, { replyToId: tweetId });
  markCommented(tweetId, body.author || '');
  return {
    ok: true,
    action: 'ai-comment',
    accountId: ctx.accountId,
    tweetId,
    replyId,
    comment,
    url: replyId === 'ok' ? null : `https://x.com/i/web/status/${replyId}`,
  };
}

async function route(req, res, cfg) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'twitter-comment-pack-api' });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }
  if (!requireToken(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const body = await readJson(req);
  if (url.pathname === '/post') return sendJson(res, 200, await handlePost(cfg, body));
  if (url.pathname === '/comment') return sendJson(res, 200, await handleComment(cfg, body));
  if (url.pathname === '/ai-comment') return sendJson(res, 200, await handleAiComment(cfg, body));
  return sendJson(res, 404, { ok: false, error: 'Not found' });
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

async function main() {
  const cfg = loadConfig();
  initStore('data/store.db');

  const server = http.createServer((req, res) => {
    route(req, res, cfg).catch((error) => {
      log(`${req.method} ${req.url} failed: ${error.message}`);
      sendJson(res, 400, { ok: false, error: error.message });
    });
  });

  server.listen(PORT, HOST, () => {
    log(`API service listening on http://${HOST}:${PORT}`);
    log('Endpoints: POST /post, POST /comment, POST /ai-comment, GET /health');
  });
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
