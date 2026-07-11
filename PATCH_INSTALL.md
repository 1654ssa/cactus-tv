# CactusStreamflow v0.8.0 补丁安装

1. 按原目录结构覆盖补丁里的所有文件。
2. 按 `DELETE_THESE_FILES.txt` 删除旧 R2 版文件。
3. Cloudflare Pages 中删除 `STREAMFLOW_R2` 和 `STREAMFLOW_QUEUE` 绑定（如果以前添加过）。
4. 保留原 D1 的 `DB` 绑定。
5. 不需要 R2、Queue、额外 Worker，也不需要执行新的 SQL。
6. 提交 GitHub，等待 Pages 自动重新部署。
7. 打开 `/api/health`，确认：

```json
"streamflowReady": true,
"streamflowEngine": "cache-api"
```
