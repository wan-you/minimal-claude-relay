# Minimal Claude Relay

这是一个只保留固定上游 Claude 转发的版本：

- 不使用数据库、Redis 或管理后台
- 不做多账号调度
- 保留一个固定的入站 API Key 鉴权
- 支持 Claude Messages 原生转发
- 保留 Claude 原生 OAuth（PKCE、授权码交换、自动刷新）
- 支持 DeepSeek Harness 非流式 `web_search` 的 SSE 聚合
- 支持 DeepSeek Harness 的 thinking 参数兼容
- 支持 Codex 的 OpenAI Responses ↔ Claude Messages 转译

Claude Code 和 Anthropic Claude 使用同一种 Messages API 协议，因此原生 `/v1/messages` 请求只替换上游地址和认证头。DeepSeek Harness 的原生 Messages 请求会额外处理已知的 `thinking` 兼容写法。Codex 的 `/v1/responses` 请求则会在 Responses 和 Messages 两种协议之间转换。

## 启动

```bash
cd minimal-relay
cp .env.example .env
# 编辑 .env，填入上游 Claude API Key
set -a
. ./.env
set +a
node server.js
```

Claude Code 配置：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3000/api/"
export ANTHROPIC_AUTH_TOKEN="与 RELAY_API_KEY 相同的值"
claude
```

`RELAY_API_KEY` 是客户端进入 CRS 的 Key；`ANTHROPIC_API_KEY` 是服务端访问上游 Claude 的 Key。两者分开保存，客户端 Key 不会被转发给上游。

## Claude OAuth

使用 OAuth 时，将 `.env` 改为：

```env
CLAUDE_AUTH_MODE=oauth
ANTHROPIC_AUTH_HEADER=authorization
CLAUDE_OAUTH_STORE=.oauth-tokens.json
```

启动后，用入站 Key 获取授权 URL：

```bash
curl -H "Authorization: Bearer $RELAY_API_KEY" \
  http://127.0.0.1:3000/oauth/authorize
```

在浏览器完成 Claude 登录授权后，把浏览器回调地址提交给中转：

```bash
curl -X POST \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/oauth/exchange \
  -d '{"callbackUrl":"粘贴浏览器回调地址"}'
```

Token 会保存到 `CLAUDE_OAUTH_STORE` 指定的本地文件，并在过期前自动刷新。查看状态：

```bash
curl -H "Authorization: Bearer $RELAY_API_KEY" \
  http://127.0.0.1:3000/oauth/status
```

DeepSeek Harness 继续使用 Anthropic Messages 接口时，把它的 Base URL 指向：

```text
http://127.0.0.1:3000/api/
```

并使用同一个 `RELAY_API_KEY`。默认开启 `DEEPSEEK_HARNESS_COMPAT=true`，会把已知 Claude 模型不接受的 `thinking.type=enabled` 搭配 `budget_tokens` 转成 `thinking.type=adaptive` 和 `output_config.effort`。

DeepSeek Harness 的 `web_search` 请求虽然没有要求流式响应，但部分 Claude 上游仍会返回 SSE。中转会把 `message_start`、`server_tool_use`、`web_search_tool_result`、引用、正文和最终 usage 聚合成一个 JSON Message，再返回给 Harness。

Codex 使用 Responses 接口时，把 Responses Base URL 指向：

```text
http://127.0.0.1:3000/
```

并使用同一个 `RELAY_API_KEY`。它访问 `/v1/responses`，极简中转会把请求转给上游 Claude 的 `/v1/messages`，再把响应转回 Responses 格式。

## 支持的接口

- `GET /health`
- `GET /oauth/authorize`
- `POST /oauth/exchange`
- `GET /oauth/status`
- `POST /v1/messages`
- `POST /api/v1/messages`
- `POST /v1/messages/count_tokens`（会原样转发）
- `POST /v1/responses`（Codex Responses 转 Claude Messages）
- `POST /api/v1/responses`（Codex Responses 转 Claude Messages）

默认只监听 `127.0.0.1`。这个版本只有一个固定入站 Key，没有用户、角色或后台管理系统。
