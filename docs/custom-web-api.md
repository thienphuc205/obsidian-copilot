# Custom Web API

The **Custom API** option lets Codex Agent web tools use a web-search service
you own or operate. The service must expose a public HTTPS base URL. Copilot
adds `/search` and `/fetch` to that URL, so a base such as
`https://search.example.com/copilot` uses
`https://search.example.com/copilot/search` and
`https://search.example.com/copilot/fetch`.

Local HTTP services, private or loopback hosts, URL credentials, query strings,
and fragments are not accepted as the base URL. A trailing slash is optional.

This is a normalized web-tool API, not an OpenAI chat-compatible endpoint. It
does not implement `/v1/chat/completions`, messages, models, or any other chat
API. Copilot sends two small JSON `POST` requests and expects the normalized
result shown below.

## Search

Copilot sends the trimmed query and a result limit. The default limit is 5; the
allowed range is 1–10.

Request:

```http
POST https://search.example.com/copilot/search
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{"query":"weather in Hanoi","limit":5}
```

Response:

```json
{
  "kind": "web_search",
  "content": "A short answer from the search service.",
  "sources": [
    {
      "title": "Example weather report",
      "url": "https://example.com/weather",
      "snippet": "Today's forecast.",
      "publishedAt": "2026-09-11"
    }
  ],
  "citations": ["https://example.com/weather"]
}
```

`query` must be 1–512 characters after trimming. `content` can contain at
most 50,000 characters. Every source needs a title and a public HTTP(S) URL;
`snippet` and `publishedAt` are optional. Copilot keeps at most 10 unique safe
sources and 50 unique safe citations. Unsafe links are omitted. Malformed
fields or an invalid envelope cause the request to fail without exposing the
API key or the response body.

## Fetch

Copilot sends one public URL:

```http
POST https://search.example.com/copilot/fetch
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{"url":"https://example.com/article"}
```

Response:

```json
{
  "kind": "web_fetch",
  "url": "https://example.com/article",
  "content": "The extracted article text.",
  "sources": [
    {
      "title": "Example article",
      "url": "https://example.com/article"
    }
  ],
  "citations": ["https://example.com/article"],
  "truncated": false
}
```

The response `url` must identify the requested URL after normal public-URL
normalization. `content` can contain at most 100,000 characters, and
`truncated` is required to be a boolean. The same source, citation, metadata,
and public-link rules used for search also apply to fetch responses. `title`
is optional on a fetch response.

## Authentication and costs

Copilot sends the API key only as the `Authorization: Bearer` header. It does
not put the key in the JSON body, query string, error messages, agent
environment, or vault. Copilot sends the explicit query or URL supplied to the
tool; it does not attach vault files or chat history automatically. An agent
can still include private text in a query, so use this setting only with a
service and account you trust.

Your service may charge for search requests, page extraction, compute, network
traffic, or downstream providers. Copilot does not set those prices or pay
them. **Test Connection** performs one search with the query `connection test`
and limit `1`, so that check may also count as a billable request.

## Limits to implement

| Field              | Requirement                                      |
| ------------------ | ------------------------------------------------ |
| Search query       | Non-empty after trimming, at most 512 characters |
| Search limit       | Integer from 1 to 10; defaults to 5              |
| Search content     | At most 50,000 characters                        |
| Fetch content      | At most 100,000 characters                       |
| Source title       | Required, at most 300 characters                 |
| Source snippet     | Optional, at most 2,000 characters               |
| Source publishedAt | Optional, at most 128 characters                 |
| Sources            | At most 10 unique public links                   |
| Citations          | At most 50 unique public links                   |
