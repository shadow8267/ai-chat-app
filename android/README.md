# AI Chat — Android 构建指南

## 前置条件

1. 安装 [Android Studio](https://developer.android.com/studio)
2. 打开 Android Studio，选择 "Open"，指向本目录（`android/`）
3. 等待 Gradle 同步完成（首次需要下载依赖，约 5-10 分钟）

## 构建 APK

### 方式一：Android Studio 图形界面

1. 点击菜单 **Build → Build Bundle(s) / APK(s) → Build APK(s)**
2. 等待构建完成
3. 点击弹窗中的 "locate" 找到 APK 文件
4. 默认路径：`android/app/build/outputs/apk/debug/app-debug.apk`

### 方式二：命令行

```bash
cd android
./gradlew assembleDebug
```

APK 生成在：`android/app/build/outputs/apk/debug/AI-Chat-v1.0-debug.apk`

## 签名发布版本（用于正式分享）

```bash
cd android
./gradlew assembleRelease
```

需要在 `app/build.gradle.kts` 中配置签名密钥。临时分享可直接用 debug 版本。

## APK 工作原理

- 所有 HTML/CSS/JS 打包在 APK 内部（`assets/www/`）
- WebView 通过 `WebViewAssetLoader` 加载本地文件
- JavaScript 正常执行，包括 API 调用、主题切换、对话管理
- 数据存储在 WebView localStorage 中
- 首次启动后需在设置中配置 API Key
- 不需要 Python 服务器，不需要网络文件托管

## 日志功能说明

APK 版本中日志调用 `/api/logs` 会失败（无本地服务器），但不会影响聊天功能。
日志写入会自动降级到 console.log。
