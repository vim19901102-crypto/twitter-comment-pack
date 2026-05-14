# API service for n8n

This service uses Twitter/X browser cookies from `data/config.json`.
It does not use the official Twitter API.

## Run on VPS

```bash
npm install
npm run setup
API_PORT=3009 API_SERVICE_TOKEN=change-me npm run api
```

The service listens on:

```text
http://0.0.0.0:3009
```

From Docker n8n on the same VPS, call:

```text
http://172.17.0.1:3009/post
http://172.17.0.1:3009/comment
http://172.17.0.1:3009/ai-comment
```

If `API_SERVICE_TOKEN` is set, send one of these headers from n8n:

```text
Authorization: Bearer change-me
```

or:

```text
x-api-key: change-me
```

## Multiple accounts

For one account, `data/config.json` can use:

```json
{
  "cookiesFile": "data/cookies.json"
}
```

For many accounts, add `accounts` and send `accountId` from n8n:

```json
{
  "cookiesFile": "data/cookies.json",
  "accounts": {
    "acc_1": { "cookiesFile": "data/cookies-acc-1.json" },
    "acc_2": { "cookiesFile": "data/cookies-acc-2.json" }
  }
}
```

## POST /post

Post a new text tweet, or a tweet with one image/video.

```json
{
  "accountId": "acc_1",
  "text": "Text from n8n"
}
```

For one default cookie account, omit `accountId`.

To post media from n8n Google Drive download, send `multipart/form-data`:

- text field: `text`
- binary file field: `source`

To post media by public URL, send JSON:

```json
{
  "text": "Caption from n8n",
  "mediaUrl": "https://example.com/file.mp4"
}
```

Supported common types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `video/mp4`, `video/quicktime`.

Response:

```json
{
  "ok": true,
  "action": "post",
  "accountId": "acc_1",
  "tweetId": "123",
  "url": "https://x.com/i/web/status/123"
}
```

## POST /comment

Comment with text supplied by n8n.

```json
{
  "accountId": "acc_1",
  "tweetUrl": "https://x.com/user/status/1234567890",
  "text": "Comment from n8n"
}
```

You can also send `tweetId` instead of `tweetUrl`.

## POST /ai-comment

Generate an AI comment, then post it as a reply.

Mode 1: n8n sends a target tweet.

```json
{
  "accountId": "acc_1",
  "tweetUrl": "https://x.com/user/status/1234567890",
  "tweetText": "Original tweet text for AI context",
  "style": "natural, short, human",
  "lang": "auto"
}
```

Current implementation requires `tweetText` because the existing repo does not yet include a reliable single-tweet fetch function.

Mode 2: n8n only triggers account warmup.

```json
{}
```

In this mode the service runs the existing warmup logic from the repo: it picks a configured reference target, generates an AI comment, then replies using the default cookie account.

## Health check

```bash
curl http://127.0.0.1:3009/health
```

Expected:

```json
{"ok":true,"service":"twitter-comment-pack-api"}
```
