# CactusStreamflow 仙人掌流式缓存

CactusStreamflow 是 Cactus TV 的 Cloudflare 云端滚动缓存层。

它不把视频下载到手机，也不会要求浏览器在后台继续运行。播放器把观看进度写入 D1，Pages 将缓存任务投递到 Queue，独立 Worker 从片源拉取 HLS 分片并写入 R2。下次播放相同影片、相同集数和相同线路时，`/api/stream` 会优先读取 R2，未命中才回源。

## 缓存规则

- 观看时长低于影片总时长的三分之一：不缓存。
- 达到三分之一后：从当前位置前约 24 秒开始，缓存“剩余时长的一半”。
- 单个播放会话最多约 950 MiB，始终小于 1 GiB。
- 全站默认最多约 5 GiB。
- 再次观看并继续前进时：删除已经看完的旧视频分片，保留当前位置附近内容，再向后补齐新的滚动窗口。
- 设置页可以关闭功能，也可以提交“清空所有 R2 缓存”任务。
- 页面被直接关闭或浏览器被系统杀掉时，最后一次延迟 Queue 消息仍会在 Cloudflare 端判断是否需要开始缓存。

## 能加速什么

当前版本只缓存 **HLS 点播**：

- `.m3u8` 或实际内容为 HLS 的地址
- 带 `#EXT-X-ENDLIST` 的点播列表
- TS 分片
- fMP4 HLS、`EXT-X-MAP`
- AES-128 密钥
- HLS Byte Range
- 主清单、多清晰度和独立音轨

暂不缓存：

- 直播 HLS
- DASH/MPD
- 普通 MP4 的任意时间区间
- DRM、Widevine、FairPlay
- 没有启用受控代理的数据源
- Cloudflare 无法访问或媒体域名未加入白名单的片源

R2 命中的部分通常会比重新请求远端片源更稳定，尤其适合慢源、跨境源和临时抖动的源。首次观看、未缓存区间和缓存任务尚未完成时仍然依赖原片源。

## 组件

```text
浏览器播放器
  ├─ 每 30 秒上报观看进度
  └─ 请求 /api/stream
          ├─ R2 命中：直接返回缓存分片
          └─ R2 未命中：回源

Pages Functions
  ├─ D1 保存会话、窗口、分片索引和状态
  └─ Queue producer 投递延迟/滚动任务

CactusStreamflow Worker
  ├─ Queue consumer
  ├─ 解析 HLS 主清单和媒体清单
  ├─ 下载目标分片到 R2
  └─ 删除已看完分片并更新 D1
```

## Cloudflare 资源名称

建议直接使用项目默认名称：

```text
D1:     cactus-tv-db
R2:     cactus-streamflow-cache
Queue:  cactus-streamflow-jobs
Worker: cactus-streamflow
```

绑定名必须完全一致：

```text
Pages / Worker D1 binding:       DB
Pages / Worker R2 binding:       STREAMFLOW_R2
Pages / Worker Queue producer:   STREAMFLOW_QUEUE
Queue consumer:                  cactus-streamflow Worker
```

## 部署

### 1. 更新主站代码

把本版本全部文件覆盖到 GitHub 仓库并提交。原来的 Pages 项目仍然从 `public` 发布，`functions` 仍位于仓库根目录。

### 2. 执行 D1 迁移

在 `cactus-tv-db` 的 D1 Console 中执行：

```text
migrations/0003_streamflow.sql
```

这会创建：

```text
streamflow_sessions
streamflow_objects
streamflow_hints
```

重复执行不会清空已有数据。

### 3. 创建 R2

Cloudflare Dashboard：

```text
R2 Object Storage
→ Create bucket
→ cactus-streamflow-cache
```

不需要公开 Bucket，也不需要绑定自定义域名。

### 4. 创建 Queue

Cloudflare Dashboard：

```text
Workers & Pages
→ Queues
→ Create queue
→ cactus-streamflow-jobs
```

一条 Queue 只能连接一个推送式 consumer。本项目的 consumer 是 `cactus-streamflow`。

### 5. 给 Pages 添加绑定

进入原来的 Cactus TV Pages 项目：

```text
Settings
→ Bindings
```

保留原来的 D1：

```text
Type: D1 database
Variable name: DB
Database: cactus-tv-db
```

新增 R2：

```text
Type: R2 bucket
Variable name: STREAMFLOW_R2
Bucket: cactus-streamflow-cache
```

新增 Queue producer：

```text
Type: Queue producer
Variable name: STREAMFLOW_QUEUE
Queue: cactus-streamflow-jobs
```

生产环境必须添加。需要预览分支也能测试时，再给 Preview 添加相同绑定。保存后重新部署 Pages。

### 6. 部署独立 Worker

项目已经包含：

```text
streamflow-worker/src/index.ts
streamflow-worker/wrangler.toml
```

打开 `streamflow-worker/wrangler.toml`，把：

```text
database_id = "替换为你的 D1 database_id"
```

改成 `cactus-tv-db` 详情页显示的真实 Database ID。

在项目根目录执行：

```bash
npm install
npm run streamflow:deploy
```

Wrangler 会部署 `cactus-streamflow`，并同时连接：

```text
DB
STREAMFLOW_R2
STREAMFLOW_QUEUE producer
cactus-streamflow-jobs consumer
```

同一 Queue 不要再绑定第二个 consumer。

如果数据源只写在 Pages 的 `PROVIDERS_JSON`，而没有保存在 D1 的 `providers` 表中，还要把同一份 `PROVIDERS_JSON` 配到 CactusStreamflow Worker。通常直接在 `/admin.html` 管理数据源即可，不需要额外变量。

### 7. 重新部署 Pages

R2 和 Queue 绑定保存后，重新部署最新 GitHub 提交。打开：

```text
/api/health
```

应看到：

```json
"streamflowReady": true
```

打开 Worker 的 `workers.dev` 地址，应看到：

```json
{"ok":true,"service":"CactusStreamflow","version":"0.1.0"}
```

## 使用与检查

1. 确认数据源开启了“受控播放代理”。
2. 播放一个 HLS 点播视频超过三分之一。
3. 关闭播放器或网页。
4. 等 Queue consumer 完成任务。
5. 打开播放设置，查看“CactusStreamflow 仙人掌流式缓存”。

状态可能显示：

```text
分析中
缓存中
已就绪
达到单集上限
失败
清理中
```

浏览器开发者工具中，命中 R2 的分片响应会带：

```text
x-cactus-streamflow: HIT
```

未命中并回源时会带：

```text
x-cactus-streamflow: MISS
```

## 默认限制

在 `streamflow-worker/wrangler.toml` 中：

```toml
STREAMFLOW_MAX_HEIGHT = "1080"
STREAMFLOW_MAX_BYTES = "996147200"
STREAMFLOW_BATCH_OBJECTS = "7"
STREAMFLOW_TOTAL_MAX_BYTES = "5000000000"
```

含义：

- 后台默认最多缓存 1080p 变体。
- 单会话上限 950 MiB。
- 每条 Queue 消息最多处理 7 个对象，避免一次调用拉取过多分片。
- 全站上限为 5 GB。

不建议把单会话上限调到精确 1 GiB，播放列表、音轨、初始化分片和密钥也会占用少量空间。

## 故障排查

### 设置页显示“未绑定 R2、Queue 或 D1”

检查 Pages 的三个绑定名：

```text
DB
STREAMFLOW_R2
STREAMFLOW_QUEUE
```

修改绑定后必须重新部署 Pages。

### 一直没有缓存

依次确认：

- 已观看超过总时长三分之一。
- 视频是 HLS 点播，不是 MP4、DASH 或直播。
- 数据源开启受控播放代理。
- 媒体域名已加入该数据源的媒体白名单。
- Queue 已连接 `cactus-streamflow` consumer。
- Worker 与 Pages 绑定的是同一个 D1、R2 和 Queue。

### 状态显示失败

设置页会显示最近错误。常见原因：

- 分片域名未在白名单。
- 上游签名过期。
- m3u8 没有 `#EXT-X-ENDLIST`。
- 上游禁止 Cloudflare Worker 访问。
- 数据源请求依赖的 Header 没有配置到数据源。

### 清空后仍显示对象

清空是 Queue 分批任务，不是浏览器同步删除。刷新状态即可；对象较多时需要多个 Queue 批次。
