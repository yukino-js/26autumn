# 文档结构

本文件记录 `content` 目录的当前结构; 每个页面的 `local_path` 标注其源码事实来源 (无标注者为通用技术手册或版本基线页).

```txt
content
├── _nav.json
├── be
│   ├── _meta.json
│   ├── clickhouse.md
│   ├── kafka.md
│   ├── index.md
│   ├── etcd.md
│   ├── groupcache.md
│   ├── grpc.md
│   ├── prometheus.md
│   ├── opentelemetry.md
│   ├── node-pool.md # local_path: $HOME/Downloads/node-pool
│   ├── wanproxy.md # local_path: $HOME/github/wanproxy
│   ├── yukino-cache-aside.md # local_path: $HOME/github/yukino.go/components/cache_aside
│   ├── yukino-consistent-hash.md # local_path: $HOME/github/yukino.go/components/consistent_hash
│   ├── yukino-lsm-tree.md # local_path: $HOME/github/yukino.go/components/lsm_tree
│   ├── yukino-raft.md # local_path: $HOME/github/yukino.go/components/raft
│   ├── yukino-redis-lock.md # local_path: $HOME/github/yukino.go/components/redis_lock
│   ├── yukino-redis-mq.md # local_path: $HOME/github/yukino.go/components/redis_mq
│   ├── yukino-tcc.md # local_path: $HOME/github/yukino.go/components/tcc
│   ├── yukino-time-wheel.md # local_path: $HOME/github/yukino.go/components/time_wheel
│   ├── yukino-agent-proxy.md # local_path: $HOME/github/yukino.go/apps/agent_proxy
│   ├── yukino-cloud-storage.md # local_path: $HOME/github/yukino.go/apps/cloud_storage
│   ├── yukino-raft-kv.md # local_path: $HOME/github/yukino.go/apps/raft_kv
│   ├── yukino-scheduled-task.md # local_path: $HOME/github/yukino.go/apps/scheduled_task
│   ├── yukino-task-flow.md # local_path: $HOME/github/yukino.go/apps/task_flow
│   ├── yukino-cache.md # local_path: $HOME/github/yukino.go/libs/yukino_cache
│   ├── yukino-http.md # local_path: $HOME/github/yukino.go/libs/yukino_http
│   ├── yukino-log.md # local_path: $HOME/github/yukino.go/libs/yukino_log
│   ├── yukino-orm.md # local_path: $HOME/github/yukino.go/libs/yukino_orm
│   ├── yukino-rpc.md # local_path: $HOME/github/yukino.go/libs/yukino_rpc
│   └── yukino-skiplist.md # local_path: $HOME/github/yukino.go/libs/yukino_skiplist
├── docs
│   ├── _meta.json
│   ├── a2ui.md # local_path: $HOME/Downloads/a2ui
│   ├── claude-code.md # local_path: $HOME/Downloads/claude-code
│   ├── docker.md
│   ├── k8s.md
│   ├── agent-sandbox.md
│   ├── ieg.md # local_path: $HOME/github/r/src/data/default-resume.json
│   ├── index.md
│   ├── langchain.md # local_path: $HOME/Downloads/langchainjs
│   ├── langgraph.md # local_path: $HOME/Downloads/langgraphjs
│   ├── mcp-app.md # local_path: $HOME/Downloads/ext-app
│   ├── pi.md # local_path: $HOME/Downloads/pi
│   ├── tiktok.md # local_path: $HOME/github/r/src/data/default-resume.json
│   ├── yukino # local_path: $HOME/github/yukino-code/packages/yukino
│   ├── yukino-dev-agent # local_path: $HOME/github/yukino-dev-agent
│   └── yukino-ecomm-agent # local_path: $HOME/github/yukino-ecomm-agent
├── fe
│   ├── _meta.json
│   ├── fetchpriority.md
│   ├── swr.md
│   ├── index.md
│   ├── tanstack-query.md
│   ├── tanstack-router.md
│   ├── tanstack-start.md
│   ├── tanstack-virtual.md
│   ├── tanstack-form.md
│   ├── yukino-chat.md # local_path: $HOME/github/yukino-chat
│   ├── yukino-chatbot.md # local_path: $HOME/github/yukino-chatbot
│   ├── yukino-anti-copy.md # local_path: $HOME/github/yukino.js/packages/anti-copy
│   ├── yukino-codegen.md # local_path: $HOME/github/yukino-codegen
│   ├── yukino-bloom-filter.md # local_path: $HOME/github/yukino.js/packages/bloom-filter
│   ├── yukino-cache.md # local_path: $HOME/github/yukino.js/packages/cache
│   ├── yukino-create-servers.md # local_path: $HOME/github/yukino.js/packages/create-servers
│   ├── yukino-http-proxy.md # local_path: $HOME/github/yukino.js/packages/http-proxy
│   ├── yukino-http-server.md # local_path: $HOME/github/yukino.js/packages/http-server
│   ├── yukino-lit-jsx.md # local_path: $HOME/github/yukino.js/packages/lit-jsx
│   ├── yukino-port-finder.md # local_path: $HOME/github/yukino.js/packages/port-finder
│   ├── yukino-promises-a-plus.md # local_path: $HOME/github/yukino.js/packages/promises-a-plus
│   ├── yukino-redis-lock.md # local_path: $HOME/github/yukino.js/packages/redis-lock
│   ├── yukino-registry-mock.md # local_path: $HOME/github/yukino.js/packages/registry-mock
│   ├── yukino-skiplist.md # local_path: $HOME/github/yukino.js/packages/skiplist
│   └── yukino-mcp.md # local_path: $HOME/github/yukino-code/packages/mcp
├── index.md
└── public
    ├── favicon.ico
    ├── favicon.svg
    └── robots.txt
```
