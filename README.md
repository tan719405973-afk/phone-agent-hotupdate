# phone-agent 热更新 / 分享页

这个仓库通过 GitHub Pages 对外提供 phone-agent（创作助手）的网页热更新文件。

## 文件说明
- `index.html` —— App 的网页主体（手机「检查更新」时下载并应用）
- `version.json` —— 版本信息（手机据此判断有没有新版）
- `.nojekyll` —— 让 GitHub Pages 原样输出，不加工 HTML

## 手机端更新地址
```
https://tan719405973-afk.github.io/phone-agent-hotupdate
```
在 App 内：设置 → 关于 → 检查更新地址，填上面这行即可。

## 更新流程（电脑端）
1. 改好 `index.html`
2. 把 `version.json` 的版本号 +1
3. 先提交 index.html，再提交 version.json，push
