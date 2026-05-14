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

Post a new text tweet.

```json
{
  "accountId": "acc_1",
  "text": "Text from n8n"
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

Mode 2: n8n only triggers account warmup.

```json
{}
```

In this mode the service runs the existing warmup logic from the repo.

## Health check

```bash
curl http://127.0.0.1:3009/health
```

Expected:

```json
{"ok":true,"service":"twitter-comment-pack-api"}
```
