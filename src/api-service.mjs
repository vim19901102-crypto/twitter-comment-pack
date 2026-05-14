/**
 * HTTP API service for n8n/VPS usage.
 * Uses Twitter/X web cookies from data/config.json, not the official Twitter API.
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.mjs';
import { generateComment } from './lib/ai-commenter.mjs';
import { fetchListTweets, postTweet, uploadMedia } from './lib/twitter-http.mjs';
import { detectLanguage } from './lib/language.mjs';
import { alreadyCommented, initStore, markCommented } from './lib/store.mjs';
import { runWarmup } from './warmup.mjs';

const PORT = Number(process.env.PORT || process.env.API_PORT || 3009);
const HOST = process.env.HOST || '0.0.0.0';
const API_TOKEN = process.env.API_SERVICE_TOKEN || process.env.N8N_API_TOKEN || '';
const MAX_BODY_BYTES = Number(process.env.API_MAX_BODY_BYTES || 512 * 1024 * 1024);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  const text = raw.toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Body must be valid JSON');
  }
}

function parseMultipartBody(raw, contentType) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType || '');
  if (!boundaryMatch) throw new Error('multipart boundary missing');
  const boundary = `--${boundaryMatch[1].replace(/^"|"$/g, '')}`;
  const body = raw.toString('latin1');
  const parts = body.split(boundary).slice(1, -1);
  const fields = {};
  const files = [];

  for (const part of parts) {
    const normalized = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const headerEnd = normalized.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerText = normalized.slice(0, headerEnd);
    const contentText = normalized.slice(headerEnd + 4);
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headerText)?.[1] || '';
    const name = /name="([^"]+)"/i.exec(disposition)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const mimeType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim();
    const content = Buffer.from(contentText, 'latin1');
    if (filename !== undefined && filename !== '') {
      files.push({ name, filename, mimeType: mimeType || 'application/octet-stream', buffer: content });
    } else {
      fields[name] = content.toString('utf8');
    }
  }

  return { ...fields, files };
}

async function readBody(req) {
  const raw = await readRawBody(req);
  const contentType = String(req.headers['content-type'] || '');
  if (contentType.includes('multipart/form-data')) return parseMultipartBody(raw, contentType);
  return parseJsonBody(raw);
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

function inferMimeFromName(filename = '') {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

function downloadUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many mediaUrl redirects'));
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(parsed, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        downloadUrl(nextUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`mediaUrl download failed (${res.statusCode})`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error('Downloaded media is too large'));
        }
      });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const mimeType = String(res.headers['content-type'] || '').split(';')[0] || inferMimeFromName(parsed.pathname);
        resolve({ buffer, mimeType, filename: path.basename(parsed.pathname) || 'media' });
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('mediaUrl download timeout'));
    });
  });
}

async function resolveMedia(body) {
  const files = Array.isArray(body.files) ? body.files : [];
  const file = files.find((item) => item.name === 'source' || item.name === 'media' || item.name === 'data') || files[0];
  if (file) {
    return {
      buffer: file.buffer,
      mimeType: file.mimeType || inferMimeFromName(file.filename),
      filename: file.filename || 'media',
    };
  }

  if (body.mediaBase64) {
    return {
      buffer: Buffer.from(String(body.mediaBase64), 'base64'),
      mimeType: body.mediaType || body.mimeType || inferMimeFromName(body.filename),
      filename: body.filename || 'media',
    };
  }

  const mediaUrl = String(body.mediaUrl || body.link_media || '').trim();
  if (mediaUrl) return downloadUrl(mediaUrl);
  return null;
}

async function handlePost(cfg, body) {
  const ctx = requestContext(cfg, body);
  const text = cleanText(body.text || body.content || body.caption, 'text');
  const media = await resolveMedia(body);
  const mediaIds = [];
  if (media) {
    const mediaId = await uploadMedia(media.buffer, media.mimeType, ctx.cookiesFile, {
      filename: media.filename,
      mediaCategory: body.mediaCategory,
    });
    mediaIds.push(mediaId);
  }
  const tweetId = await postTweet(text, ctx.cookiesFile, { mediaIds });
  return {
    ok: true,
    action: 'post',
    accountId: ctx.accountId,
    tweetId,
    mediaIds,
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

async function handleAiCommentFromLists(cfg, ctx) {
  const listIds = cfg.modeA?.listIds || [];
  if (!Array.isArray(listIds) || listIds.length === 0) return null;

  const candidates = [];
  const seen = new Set();
  for (const listId of listIds) {
    const tweets = await fetchListTweets(String(listId).trim(), ctx.cookiesFile, 30);
    for (const tweet of tweets) {
      if (!tweet.id || !tweet.fullText || tweet.fullText.length < 10) continue;
      if (tweet.isRetweet || tweet.inReplyToStatusId) continue;
      if (seen.has(tweet.id) || alreadyCommented(tweet.id)) continue;
      seen.add(tweet.id);
      candidates.push({ ...tweet, listId: String(listId).trim() });
    }
  }

  candidates.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const target = candidates[0];
  if (!target) {
    return {
      ok: true,
      action: 'ai-comment',
      mode: 'list',
      accountId: ctx.accountId,
      skipped: true,
      reason: 'No eligible tweet found in configured lists',
    };
  }

  const langSetting = ctx.lang || 'auto';
  const lang = langSetting === 'auto' ? detectLanguage(target.fullText) : langSetting;
  const comment = await generateComment({
    tweetText: target.fullText,
    lang,
    style: ctx.style,
    ai: cfg.ai,
  });
  const replyId = await postTweet(comment, ctx.cookiesFile, { replyToId: target.id });
  markCommented(target.id, target.author || '');

  return {
    ok: true,
    action: 'ai-comment',
    mode: 'list',
    accountId: ctx.accountId,
    listId: target.listId,
    targetTweetId: target.id,
    targetAuthor: target.author,
    targetUrl: `https://x.com/i/web/status/${target.id}`,
    replyId,
    replyUrl: replyId === 'ok' ? null : `https://x.com/i/web/status/${replyId}`,
    comment,
    lang,
  };
}

async function handleAiComment(cfg, body) {
  const ctx = requestContext(cfg, body);
  const tweetId = parseTweetId(body.tweetId || body.replyToId || body.tweetUrl || body.url || body.link);
  if (!tweetId) {
    const listResult = await handleAiCommentFromLists(cfg, ctx);
    if (listResult) return listResult;
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

  const body = await readBody(req);
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
