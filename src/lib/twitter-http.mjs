/**
 * Pure HTTP Twitter/X client — cookie auth + x-client-transaction-id header.
 * No browser, no Playwright.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { ClientTransaction } from 'x-client-transaction-id';
import { JSDOM } from 'jsdom';

if (typeof ArrayBuffer.prototype.transfer !== 'function') {
  Object.defineProperty(ArrayBuffer.prototype, 'transfer', {
    value(newByteLength = this.byteLength) {
      const length = Math.max(0, Number(newByteLength));
      const next = new ArrayBuffer(length);
      const source = new Uint8Array(this);
      new Uint8Array(next).set(source.subarray(0, Math.min(source.byteLength, length)));
      return next;
    },
  });
}

const BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let ctInstance = null;
let ctCreatedAt = 0;
const CT_TTL = 30 * 60 * 1000;

async function getClientTransaction() {
  if (ctInstance && Date.now() - ctCreatedAt < CT_TTL) return ctInstance;
  const html = await httpGet('https://x.com', { 'User-Agent': UA, Accept: 'text/html' });
  const dom = new JSDOM(html);
  const ct = new ClientTransaction(dom.window.document);
  await ct.initialize();
  ctInstance = ct;
  ctCreatedAt = Date.now();
  return ct;
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https
      .get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            httpGet(res.headers.location, headers).then(resolve, reject);
            return;
          }
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve(data));
          res.on('error', reject);
        },
      )
      .on('error', reject);
  });
}

function httpRequest(method, hostname, apiPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: apiPath, method, headers, timeout: 60000 },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

function formBody(values) {
  return new URLSearchParams(values).toString();
}

function multipartBody(fields, file) {
  const boundary = `----twitter-comment-pack-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(String(value)));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(Buffer.from(`Content-Disposition: form-data; name="media"; filename="${file.filename || 'media'}"\r\n`));
  chunks.push(Buffer.from(`Content-Type: ${file.mimeType || 'application/octet-stream'}\r\n\r\n`));
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function makeUploadHeaders(method, apiPath, cookiesFilePath, contentType) {
  const { cookieStr, ct0 } = readCookies(cookiesFilePath);
  const ct = await getClientTransaction();
  const txId = await ct.generateTransactionId(method, apiPath);
  return {
    authorization: BEARER,
    cookie: cookieStr,
    'x-csrf-token': ct0,
    'x-client-transaction-id': txId,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'content-type': contentType,
    'user-agent': UA,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    referer: 'https://x.com/',
    origin: 'https://x.com',
  };
}

function parseJsonResponse(result, label) {
  let data;
  try {
    data = JSON.parse(result.body || '{}');
  } catch {
    throw new Error(`${label} returned invalid JSON (${result.status}): ${String(result.body).slice(0, 200)}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label} failed (${result.status}): ${String(result.body).slice(0, 300)}`);
  }
  return data;
}

function findTweetId(value, depth = 0) {
  if (!value || depth > 8) return null;
  if (typeof value !== 'object') return null;

  if (typeof value.rest_id === 'string' && /^\d{10,25}$/.test(value.rest_id)) {
    return value.rest_id;
  }
  if (typeof value.id_str === 'string' && /^\d{10,25}$/.test(value.id_str)) {
    return value.id_str;
  }

  for (const child of Object.values(value)) {
    const found = findTweetId(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function readCookies(cookiesFilePath) {
  const raw = JSON.parse(fs.readFileSync(cookiesFilePath, 'utf-8'));
  const cookies = raw.cookies || [];
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const ct0Cookie = cookies.find((c) => c.name === 'ct0');
  if (!ct0Cookie) throw new Error('ct0 cookie not found in ' + path.basename(cookiesFilePath));
  return { cookieStr, ct0: ct0Cookie.value };
}

async function makeHeaders(method, apiPath, cookiesFilePath) {
  const { cookieStr, ct0 } = readCookies(cookiesFilePath);
  const ct = await getClientTransaction();
  const txId = await ct.generateTransactionId(method, apiPath);
  return {
    authorization: BEARER,
    cookie: cookieStr,
    'x-csrf-token': ct0,
    'x-client-transaction-id': txId,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'content-type': 'application/json',
    'user-agent': UA,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    referer: 'https://x.com/',
    origin: 'https://x.com',
  };
}

const TWEET_FEATURES = {
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

const SEARCH_FEATURES = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: false,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

const SEARCH_FIELD_TOGGLES = {
  withPayments: false,
  withAuxiliaryUserLabels: false,
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withArticleSummaryText: false,
  withArticleVoiceOver: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
};

function twitterCreatedAtToIso(s) {
  if (!s) return new Date().toISOString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function parseTweetEntry(entry) {
  const tweet = entry?.content?.itemContent?.tweet_results?.result;
  if (!tweet) return null;
  const legacy = tweet.legacy || tweet.tweet?.legacy;
  if (!legacy) return null;
  const userResult =
    tweet.core?.user_results?.result ||
    tweet.tweet?.core?.user_results?.result;
  const author =
    userResult?.core?.screen_name ||
    userResult?.legacy?.screen_name ||
    'unknown';
  return {
    id: tweet.rest_id || tweet.tweet?.rest_id || legacy.id_str,
    fullText: legacy.full_text || '',
    author,
    createdAt: twitterCreatedAtToIso(legacy.created_at),
    lang: legacy.lang,
    inReplyToStatusId: legacy.in_reply_to_status_id_str || null,
    isRetweet: Boolean(legacy.retweeted_status_result) || Boolean(legacy.retweeted_status_id_str),
  };
}

export async function postTweet(text, cookiesFilePath, options = {}) {
  const queryId = 'oB-5XsHNAbjvARJEc8CZFw';
  const apiPath = `/i/api/graphql/${queryId}/CreateTweet`;
  const headers = await makeHeaders('POST', apiPath, cookiesFilePath);

  const variables = {
    tweet_text: text,
    dark_request: false,
    media: {
      media_entities: (options.mediaIds || []).map((id) => ({ media_id: id, tagged_users: [] })),
      possibly_sensitive: false,
    },
    semantic_annotation_ids: [],
  };
  if (options.replyToId) {
    variables.reply = { in_reply_to_tweet_id: options.replyToId, exclude_reply_user_ids: [] };
  }

  const payload = JSON.stringify({ variables, features: TWEET_FEATURES, queryId });
  const result = await httpRequest('POST', 'x.com', apiPath, headers, payload);

  if (result.status === 429) throw new Error('RATE_LIMITED 429');
  if (result.status === 403) throw new Error('RATE_LIMITED 403');
  if (result.status !== 200) {
    throw new Error(`CreateTweet failed (${result.status}): ${result.body.slice(0, 200)}`);
  }
  const data = JSON.parse(result.body);
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw new Error(`CreateTweet returned errors: ${JSON.stringify(data.errors).slice(0, 500)}`);
  }
  const tweetResult = data?.data?.create_tweet?.tweet_results?.result;
  const tweetId = findTweetId(tweetResult);
  if (!tweetId) {
    throw new Error(`CreateTweet returned no tweet id: ${result.body.slice(0, 500)}`);
  }
  return tweetId;
}

export async function uploadMedia(buffer, mimeType, cookiesFilePath, options = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (!buffer.length) throw new Error('media file is empty');

  const mediaType = mimeType || 'application/octet-stream';
  const isVideo = mediaType.startsWith('video/');
  const mediaCategory = options.mediaCategory || (isVideo ? 'tweet_video' : 'tweet_image');
  const uploadPath = '/i/media/upload.json';

  const initPayload = formBody({
    command: 'INIT',
    total_bytes: String(buffer.length),
    media_type: mediaType,
    media_category: mediaCategory,
  });
  let headers = await makeUploadHeaders('POST', uploadPath, cookiesFilePath, 'application/x-www-form-urlencoded');
  headers['content-length'] = Buffer.byteLength(initPayload);
  const initResult = await httpRequest('POST', 'upload.twitter.com', uploadPath, headers, initPayload);
  const initData = parseJsonResponse(initResult, 'Media INIT');
  const mediaId = initData.media_id_string || String(initData.media_id || '');
  if (!mediaId) throw new Error('Media INIT did not return media_id');

  const chunkSize = Number(process.env.TWITTER_UPLOAD_CHUNK_BYTES || 4 * 1024 * 1024);
  let segmentIndex = 0;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
    const { body, contentType } = multipartBody(
      {
        command: 'APPEND',
        media_id: mediaId,
        segment_index: String(segmentIndex),
      },
      {
        buffer: chunk,
        filename: options.filename || 'media',
        mimeType: mediaType,
      },
    );
    headers = await makeUploadHeaders('POST', uploadPath, cookiesFilePath, contentType);
    headers['content-length'] = body.length;
    const appendResult = await httpRequest('POST', 'upload.twitter.com', uploadPath, headers, body);
    if (appendResult.status < 200 || appendResult.status >= 300) {
      throw new Error(`Media APPEND failed (${appendResult.status}): ${appendResult.body.slice(0, 300)}`);
    }
    segmentIndex += 1;
  }

  const finalizePayload = formBody({ command: 'FINALIZE', media_id: mediaId });
  headers = await makeUploadHeaders('POST', uploadPath, cookiesFilePath, 'application/x-www-form-urlencoded');
  headers['content-length'] = Buffer.byteLength(finalizePayload);
  const finalizeResult = await httpRequest('POST', 'upload.twitter.com', uploadPath, headers, finalizePayload);
  let finalizeData = parseJsonResponse(finalizeResult, 'Media FINALIZE');

  let processing = finalizeData.processing_info;
  while (processing && !['succeeded', 'failed'].includes(processing.state)) {
    const waitSeconds = Math.max(1, Number(processing.check_after_secs || 2));
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    const statusPath = `${uploadPath}?${formBody({ command: 'STATUS', media_id: mediaId })}`;
    headers = await makeUploadHeaders('GET', statusPath, cookiesFilePath, 'application/x-www-form-urlencoded');
    const statusResult = await httpRequest('GET', 'upload.twitter.com', statusPath, headers);
    finalizeData = parseJsonResponse(statusResult, 'Media STATUS');
    processing = finalizeData.processing_info;
  }

  if (processing?.state === 'failed') {
    throw new Error(`Media processing failed: ${JSON.stringify(processing.error || processing).slice(0, 300)}`);
  }

  return mediaId;
}

export async function searchUserTweets(username, cookiesFilePath, count = 10) {
  const queryId = 'E3opETHurmVJflFsUBVuUQ';
  const userId = await getUserId(username, cookiesFilePath);
  if (!userId) return [];

  const variables = JSON.stringify({
    userId,
    count,
    includePromotedContent: false,
    withVoice: false,
    withV2Timeline: true,
  });
  const features = JSON.stringify(TWEET_FEATURES);
  const apiPath = `/i/api/graphql/${queryId}/UserTweets?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const headers = await makeHeaders('GET', apiPath, cookiesFilePath);

  const result = await httpRequest('GET', 'x.com', apiPath, headers);
  if (result.status !== 200) {
    throw new Error(`UserTweets failed (${result.status}): ${result.body.slice(0, 200)}`);
  }
  const data = JSON.parse(result.body);
  const instructions =
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
    data?.data?.user?.result?.timeline?.timeline?.instructions ||
    [];
  const out = [];
  for (const instr of instructions) {
    if (instr.type === 'TimelineAddEntries' || instr.type === 'TimelinePinEntry') {
      const entries = instr.entries || (instr.entry ? [instr.entry] : []);
      for (const e of entries) {
        if (e.content?.entryType !== 'TimelineTimelineItem') continue;
        const t = parseTweetEntry(e);
        if (t) {
          if (t.author === 'unknown') t.author = username;
          out.push(t);
        }
      }
    }
  }
  return out;
}

export async function fetchListTweets(listId, cookiesFilePath, count = 20) {
  const queryId = '2Vjeyo_L0nizAUhHe3fKyA';
  const variables = JSON.stringify({ listId, count });
  const features = JSON.stringify(TWEET_FEATURES);
  const apiPath = `/i/api/graphql/${queryId}/ListLatestTweetsTimeline?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const headers = await makeHeaders('GET', apiPath, cookiesFilePath);
  const result = await httpRequest('GET', 'x.com', apiPath, headers);
  if (result.status !== 200) {
    throw new Error(`ListTweets failed (${result.status}): ${result.body.slice(0, 200)}`);
  }
  const data = JSON.parse(result.body);
  const instructions = data?.data?.list?.tweets_timeline?.timeline?.instructions || [];
  const out = [];
  for (const instr of instructions) {
    if (instr.type !== 'TimelineAddEntries') continue;
    for (const e of instr.entries || []) {
      if (e.content?.entryType !== 'TimelineTimelineItem') continue;
      const t = parseTweetEntry(e);
      if (t) out.push(t);
    }
  }
  return out;
}

export async function searchTimeline(rawQuery, cookiesFilePath, cursor = null, product = 'Latest') {
  const queryId = process.env.TWITTER_SEARCH_QUERY_ID || 'R0u1RWRf748KzyGBXvOYRA';
  const variables = { rawQuery, count: 20, querySource: 'typed_query', product };
  if (cursor) variables.cursor = cursor;

  const apiPath = `/i/api/graphql/${queryId}/SearchTimeline`;
  const headers = await makeHeaders('POST', apiPath, cookiesFilePath);
  const payload = JSON.stringify({
    variables,
    features: SEARCH_FEATURES,
    fieldToggles: SEARCH_FIELD_TOGGLES,
    queryId,
  });
  const result = await httpRequest('POST', 'x.com', apiPath, headers, payload);
  if (result.status === 429 || result.status === 403) {
    throw new Error(`RATE_LIMITED ${result.status}`);
  }
  if (result.status !== 200) {
    throw new Error(`SearchTimeline failed (${result.status}): ${result.body.slice(0, 200)}`);
  }
  const data = JSON.parse(result.body);
  const instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
  const tweets = [];
  let nextCursor = null;
  for (const instr of instructions) {
    const entries =
      instr.type === 'TimelineAddEntries' ? instr.entries : instr.entry ? [instr.entry] : [];
    for (const e of entries || []) {
      const et = e?.content?.entryType;
      if (et === 'TimelineTimelineItem') {
        const t = parseTweetEntry(e);
        if (t) tweets.push(t);
      } else if (et === 'TimelineTimelineCursor') {
        if (e.content.cursorType === 'Bottom') nextCursor = e.content.value;
      }
    }
  }
  return { tweets, nextCursor };
}

export async function getUserId(username, cookiesFilePath) {
  const queryId = 'xc8f1g7BYqr6VTzTbvNlGw';
  const variables = JSON.stringify({ screen_name: username, withSafetyModeUserFields: true });
  const features = JSON.stringify({
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  });
  const apiPath = `/i/api/graphql/${queryId}/UserByScreenName?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const headers = await makeHeaders('GET', apiPath, cookiesFilePath);
  const result = await httpRequest('GET', 'x.com', apiPath, headers);
  if (result.status !== 200) return null;
  const data = JSON.parse(result.body);
  return data?.data?.user?.result?.rest_id || null;
}

export async function favoriteTweet(tweetId, cookiesFilePath) {
  const queryId = 'lI07N6Otwv1PhnEgXILM7A';
  const apiPath = `/i/api/graphql/${queryId}/FavoriteTweet`;
  const headers = await makeHeaders('POST', apiPath, cookiesFilePath);
  const payload = JSON.stringify({ variables: { tweet_id: tweetId }, queryId });
  const result = await httpRequest('POST', 'x.com', apiPath, headers, payload);
  if (result.status === 429 || result.status === 403) throw new Error(`RATE_LIMITED ${result.status}`);
  if (result.status !== 200) throw new Error(`FavoriteTweet failed (${result.status})`);
  return true;
}

export async function followUser(userId, cookiesFilePath) {
  const apiPath = `/i/api/1.1/friendships/create.json`;
  const { cookieStr, ct0 } = readCookies(cookiesFilePath);
  const ct = await getClientTransaction();
  const txId = await ct.generateTransactionId('POST', apiPath);
  const headers = {
    authorization: BEARER,
    cookie: cookieStr,
    'x-csrf-token': ct0,
    'x-client-transaction-id': txId,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': UA,
    accept: '*/*',
    referer: 'https://x.com/',
    origin: 'https://x.com',
  };
  const payload = `user_id=${encodeURIComponent(userId)}&include_profile_interstitial_type=1&skip_status=true`;
  const result = await httpRequest('POST', 'x.com', apiPath, headers, payload);
  if (result.status === 429 || result.status === 403) throw new Error(`RATE_LIMITED ${result.status}`);
  if (result.status !== 200) throw new Error(`Follow failed (${result.status})`);
  return JSON.parse(result.body);
}

export async function getFriendship(username, cookiesFilePath) {
  const apiPath = `/i/api/1.1/friendships/show.json?screen_name=${encodeURIComponent(username)}`;
  const { cookieStr, ct0 } = readCookies(cookiesFilePath);
  const ct = await getClientTransaction();
  const txId = await ct.generateTransactionId('GET', apiPath);
  const headers = {
    authorization: BEARER,
    cookie: cookieStr,
    'x-csrf-token': ct0,
    'x-client-transaction-id': txId,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'user-agent': UA,
    accept: '*/*',
    referer: 'https://x.com/',
    origin: 'https://x.com',
  };
  const result = await httpRequest('GET', 'x.com', apiPath, headers);
  if (result.status !== 200) return null;
  return JSON.parse(result.body);
}
