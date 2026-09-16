# Security

SurfaceLoom 能读取并操作桌面应用的 Accessibility/UI Automation 树。获得辅助功能或同等
权限的 runner 可能观察界面内容并触发用户动作，因此应把它视为高权限测试工具。

## 安全边界

- 只给固定路径、可审计的 test runner 授权，不给临时下载或未知二进制授权。
- 默认使用隔离 profile 和测试账号；真实用户 profile 必须显式启用。
- owned 进程可以由 runner 清理；attached/external 进程只能 detach/release。
- 不自动接受 TCC、Windows 隐私权限、UAC、SmartScreen 或其他安全提示。
- 不调用 `tccutil reset`，不修改 Secure Desktop、系统隐私或网络安全设置。
- 真实消息、上传、模型和工具调用必须声明 `externalEffect` 并使用单独门禁。
- trace、截图、AX/UIA tree 和录屏可能包含会话、路径或账号信息，分享前必须脱敏。
- runner 接入 attach/existing-profile 时必须显式关闭媒体 retention；确需采集的敏感附件不得由
  HTML 或 AI 摘要自动展开。
- runner 不得把凭据传给 Reporter。Reporter 会对元数据中的常见字段、供应商 token 形态和用户
  主目录做 best-effort 脱敏，并只保存附件相对路径；这层防御不能识别任意秘密，也不会扫描或
  修改截图、录屏和其他附件内容。附件必须在采集端完成脱敏。
- 证据 provider 只能提交 runner-owned 临时文件，不能把 AUT/用户传入的任意路径直接作为
  `SourceArtifact.sourcePath`。
- GUI runner 与其启动的 AUT 可能继承进程环境；不要在 live/CI runner 环境中放生产
  GitHub、云平台或模型凭据。需要的测试变量应使用最小权限、短期且专用的值。

## 不要提交

- API key、token、cookie、节点 secret 或登录凭据。
- 用户 profile、聊天记录、真实附件、录屏或未脱敏的诊断产物。
- 指向个人主目录的固定路径，除非它是明确的测试假数据。
- 绕过系统安全边界、自动批准高权限操作或静默坐标点击的实现。

## 报告问题

请通过仓库的 GitHub Security Advisory 私密报告可能导致凭据泄漏、越权 UI 操作、误终止
用户进程或绕过授权门禁的问题；不要在公开 issue 中粘贴敏感诊断数据。
