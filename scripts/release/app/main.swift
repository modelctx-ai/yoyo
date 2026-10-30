// yoyo.app 的外壳。打开时起常驻进程（Resources/yoyo start，它再开桌宠），窗口里放管理页；
// 关掉窗口桌宠照旧在，退出 app 时先让常驻进程收尾（它再关自己开的桌宠）。
// 菜单里能检查更新，开着时每隔几小时也看一次；更新本身交给 `yoyo update install`（--json 逐行报进度）。
// config.json 的 app.launchAtLogin 管开机自启：外壳每隔几秒看一眼配置，用登录项（macOS 13 以上）跟上；菜单里也能勾。
import AppKit
import ServiceManagement
import WebKit

let resources = Bundle.main.resourceURL!
let cli = resources.appendingPathComponent("yoyo").path
let environment = ProcessInfo.processInfo.environment
let home: URL = {
    if let custom = environment["YOYO_HOME"], !custom.isEmpty { return URL(fileURLWithPath: custom) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".yoyo")
}()
let configFile: URL = {
    if let custom = environment["YOYO_CONFIG"], !custom.isEmpty { return URL(fileURLWithPath: custom) }
    return home.appendingPathComponent("config.json")
}()
let logFile = home.appendingPathComponent("app.log")
let pidFile = home.appendingPathComponent("app.pid")
let directorPidFile = home.appendingPathComponent("director.pid")
/// 自己检查更新的间隔
let updateInterval: TimeInterval = 6 * 3600

/// 跑一次 `yoyo <args>`，在主线程交回退出码和输出（stdout、stderr 合在一起）。
func runCli(_ args: [String], done: @escaping (Int32, String) -> Void) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: cli)
    process.arguments = args
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    process.standardInput = FileHandle.nullDevice
    DispatchQueue.global().async {
        do {
            try process.run()
        } catch {
            DispatchQueue.main.async { done(-1, error.localizedDescription) }
            return
        }
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let status = process.terminationStatus
        DispatchQueue.main.async { done(status, text) }
    }
}

/// 读 stderr 的线程和读 stdout 的线程之间交接用的盒子
final class Collected: @unchecked Sendable {
    var data = Data()
}

/// 跑一次 `yoyo <args>`：stdout 每来一行在主线程交一次 `line`；结束时在主线程交退出码和 stderr 的内容。
/// `line` 都在 `done` 之前交完。
func runCliLines(_ args: [String], line: @escaping (String) -> Void, done: @escaping (Int32, String) -> Void) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: cli)
    process.arguments = args
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    process.standardInput = FileHandle.nullDevice
    DispatchQueue.global().async {
        do {
            try process.run()
        } catch {
            DispatchQueue.main.async { done(-1, error.localizedDescription) }
            return
        }
        // stderr 另起一个线程读：不读的话写满了，命令会卡住
        let errors = Collected()
        let errorsRead = DispatchGroup()
        errorsRead.enter()
        DispatchQueue.global().async {
            errors.data = err.fileHandleForReading.readDataToEndOfFile()
            errorsRead.leave()
        }
        var pending = Data()
        let newline = UInt8(ascii: "\n")
        while true {
            let chunk = out.fileHandleForReading.availableData
            if chunk.isEmpty { break }
            pending.append(chunk)
            while let index = pending.firstIndex(of: newline) {
                let text = String(decoding: pending[pending.startIndex..<index], as: UTF8.self)
                pending.removeSubrange(pending.startIndex...index)
                DispatchQueue.main.async { line(text) }
            }
        }
        if !pending.isEmpty {
            let text = String(decoding: pending, as: UTF8.self)
            DispatchQueue.main.async { line(text) }
        }
        process.waitUntilExit()
        errorsRead.wait()
        let status = process.terminationStatus
        let detail = String(decoding: errors.data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        DispatchQueue.main.async { done(status, detail) }
    }
}

func lastLine(_ text: String) -> String {
    return text.split(separator: "\n").last.map(String.init) ?? ""
}

func lastLines(_ text: String, _ count: Int) -> String {
    return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(count).joined(separator: "\n")
}

/// 常驻进程在跑：director.pid 里的进程还活着（可能是终端里 `yoyo start` 开的）
func directorAlive() -> Bool {
    guard let text = try? String(contentsOf: directorPidFile, encoding: .utf8),
          let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return false }
    return kill(pid, 0) == 0
}

/// 用文本编辑打开
func openText(_ file: URL) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-t", file.path]
    try? process.run()
}

func megabytes(_ bytes: Double) -> String {
    return String(format: "%.0f", bytes / 1024 / 1024)
}

/// 往 app.log 末尾补一行（外壳自己的事：登录项没注册成之类）
func appendLog(_ text: String) {
    guard let handle = try? FileHandle(forWritingTo: logFile) else { return }
    defer { try? handle.close() }
    handle.seekToEndOfFile()
    handle.write(Data("[app] \(text)\n".utf8))
}

/// config.json 里 app.launchAtLogin 现在是不是开着。认法和配置一致：true 或字符串 "true"，别的都当关着
func configWantsLaunchAtLogin() -> Bool {
    guard let data = try? Data(contentsOf: configFile),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let section = root["app"] as? [String: Any] else { return false }
    let value = section["launchAtLogin"]
    if let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
    if let text = value as? String { return text == "true" }
    return false
}

/// config.json 改过没有的凭据：修改时间加大小
func configStamp() -> String {
    let attributes = try? FileManager.default.attributesOfItem(atPath: configFile.path)
    let date = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
    let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
    return "\(date)-\(size)"
}

func escapeHtml(_ text: String) -> String {
    return text.replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var updateItem: NSMenuItem!
    var loginItem: NSMenuItem!
    /// 上次看到的 config.json 的凭据；变了才重新读
    var seenConfig: String?
    /// 上次照着办的 app.launchAtLogin；变了才去动登录项（用户在系统设置里关掉它以后，不会被我们再打开）
    var appliedLogin: Bool?
    var loginTimer: Timer?
    /// 自己起的常驻进程；接着终端里开着的那个时是 nil
    var daemon: Process?
    /// app.log 里这一次从哪里开始写
    var logStart: UInt64 = 0
    var managerLoaded = false
    var quitting = false
    var checking = false
    var installing: NSPanel?
    var timer: Timer?
    var termSource: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? "\(getpid())\n".write(to: pidFile, atomically: true, encoding: .utf8)
        handleTerm()
        buildMenu()
        buildWindow()
        if directorAlive() {
            notice("yoyo 已经在跑了，正在打开工作台…")
        } else {
            notice("yoyo 正在启动…")
            startDaemon()
        }
        waitForManager(90)
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { self.checkUpdate(manual: false) }
        timer = Timer.scheduledTimer(withTimeInterval: updateInterval, repeats: true) { _ in self.checkUpdate(manual: false) }
        syncLoginItem(manual: false)
        loginTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in self.syncLoginItem(manual: false) }
    }

    /// `yoyo update install` 换版本时给 app 发 TERM：和退出菜单一样收好再走。
    /// 处理函数不能是 SIG_IGN，不然子进程（常驻进程）跟着忽略 TERM，就停不下来了。
    func handleTerm() {
        signal(SIGTERM) { _ in }
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }
        source.resume()
        termSource = source
    }

    // MARK: 常驻进程

    func startDaemon() {
        rotateLog()
        if !FileManager.default.fileExists(atPath: logFile.path) {
            FileManager.default.createFile(atPath: logFile.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: logFile) else {
            return failed("写不了 \(logFile.path)")
        }
        logStart = handle.seekToEndOfFile()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli)
        process.arguments = ["start"]
        process.standardOutput = handle
        process.standardError = handle
        process.standardInput = FileHandle.nullDevice
        process.terminationHandler = { finished in
            DispatchQueue.main.async { self.daemonExited(finished.terminationStatus) }
        }
        do {
            try process.run()
            daemon = process
        } catch {
            failed("yoyo 没启动起来：\(error.localizedDescription)")
        }
        try? handle.close()
    }

    func rotateLog() {
        let size = (try? FileManager.default.attributesOfItem(atPath: logFile.path)[.size] as? NSNumber)?.intValue ?? 0
        guard size > 5 * 1024 * 1024 else { return }
        let old = home.appendingPathComponent("app.log.1")
        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: logFile, to: old)
    }

    func logTail() -> String {
        guard let handle = try? FileHandle(forReadingFrom: logFile) else { return "" }
        defer { try? handle.close() }
        handle.seek(toFileOffset: logStart)
        let text = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return lastLines(text, 12)
    }

    func daemonExited(_ status: Int32) {
        daemon = nil
        if quitting {
            NSApp.reply(toApplicationShouldTerminate: true)
            return
        }
        // 自己停了：配置还没填好，或者出错了
        failed(logTail())
    }

    func failed(_ detail: String) {
        notice("yoyo 没在跑。\n\n\(detail)")
        let alert = NSAlert()
        alert.messageText = "yoyo 没跑起来"
        alert.informativeText = "\(detail)\n\n改好以后再打开 yoyo。"
        alert.addButton(withTitle: "打开配置")
        alert.addButton(withTitle: "打开日志")
        alert.addButton(withTitle: "退出")
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn: openText(configFile)
        case .alertSecondButtonReturn: openText(logFile)
        default: break
        }
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let daemon = daemon, daemon.isRunning else { return .terminateNow }
        quitting = true
        // TERM 给启动脚本：它转给常驻进程，常驻进程收尾退出后再关自己开的桌宠
        daemon.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            if self.daemon != nil { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        try? FileManager.default.removeItem(at: pidFile)
    }

    // MARK: 窗口和管理页

    func buildWindow() {
        let configuration = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "yoyo"
        window.isReleasedWhenClosed = false
        window.contentView = web
        window.setFrameAutosaveName("yoyo")
        if !window.setFrameUsingName("yoyo") { window.center() }
        showWindow()
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 管理页没开着时窗口里放一句话
    func notice(_ text: String) {
        managerLoaded = false
        let html = """
        <!doctype html><meta charset="utf-8">
        <style>body{font:15px -apple-system,sans-serif;margin:48px;color:#333;white-space:pre-wrap}
        @media (prefers-color-scheme: dark){body{background:#1e1e1e;color:#ddd}}</style>
        <body>\(escapeHtml(text))</body>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    /// 等常驻进程开好管理页再放进窗口；地址每次启动都换，带着令牌
    func waitForManager(_ tries: Int) {
        runCli(["web", "url"]) { status, text in
            let line = lastLine(text)
            if status == 0, let url = URL(string: line), url.scheme == "http" {
                self.managerLoaded = true
                self.web.load(URLRequest(url: url))
                return
            }
            if self.quitting { return }
            let running = self.daemon != nil || directorAlive()
            if tries <= 0 || !running {
                if running { self.notice("工作台没开：\(line)") }
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.waitForManager(tries - 1) }
        }
    }

    @objc func reload() {
        waitForManager(5)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // 右键桌宠的「管理」、yoyo web open 都会打开 app：显示窗口，地址变了就重新取
        showWindow()
        if !managerLoaded { waitForManager(5) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    /// 管理页以外的链接交给浏览器
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https",
           url.host != "127.0.0.1" && url.host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    /// 管理页删东西前用 confirm() 问一句
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    // MARK: 更新

    @objc func checkUpdateFromMenu() {
        checkUpdate(manual: true)
    }

    func checkUpdate(manual: Bool) {
        if checking || installing != nil { return }
        checking = true
        runCli(["update", "check", "--json"]) { status, text in
            self.checking = false
            guard status == 0,
                  let info = try? JSONSerialization.jsonObject(with: Data(lastLine(text).utf8)) as? [String: Any] else {
                if manual { self.tell("没查成", lastLines(text, 4)) }
                return
            }
            let message = info["message"] as? String ?? ""
            guard info["available"] as? Bool == true, let latest = info["latest"] as? String else {
                self.updateItem.title = "检查更新…"
                if manual { self.tell("没有新版本", message) }
                return
            }
            self.updateItem.title = "更新到 \(latest)…"
            if !manual && UserDefaults.standard.string(forKey: "skippedVersion") == latest { return }
            self.offer(latest: latest, message: message, page: info["page"] as? String,
                       notes: (info["body"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines), manual: manual)
        }
    }

    func offer(latest: String, message: String, page: String?, notes: String, manual: Bool) {
        let alert = NSAlert()
        alert.messageText = "yoyo \(latest) 可以更新了"
        let hint = "\(message)。下载新的安装包（几百 MB），换好以后 yoyo 自己重开。"
        alert.informativeText = notes.isEmpty ? hint : "\(hint)\n\n更新说明："
        if !notes.isEmpty { alert.accessoryView = notesView(notes) }
        var actions: [() -> Void] = []
        alert.addButton(withTitle: "更新并重开")
        actions.append { self.install() }
        alert.addButton(withTitle: "以后再说")
        actions.append {}
        if let page = page, let url = URL(string: page) {
            alert.addButton(withTitle: "打开 Release 页")
            actions.append { NSWorkspace.shared.open(url) }
        }
        if !manual {
            alert.addButton(withTitle: "跳过这个版本")
            actions.append { UserDefaults.standard.set(latest, forKey: "skippedVersion") }
        }
        NSApp.activate(ignoringOtherApps: true)
        let index = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        if index >= 0 && index < actions.count { actions[index]() }
    }

    /// 更新说明：只读、可以滚动、可以选中复制
    func notesView(_ text: String) -> NSView {
        let scroll = NSTextView.scrollableTextView()
        scroll.frame = NSRect(x: 0, y: 0, width: 440, height: 180)
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        if let textView = scroll.documentView as? NSTextView {
            textView.isEditable = false
            textView.isSelectable = true
            textView.isRichText = false
            textView.font = NSFont.systemFont(ofSize: 12)
            textView.textContainerInset = NSSize(width: 6, height: 6)
            textView.string = text
        }
        return scroll
    }

    func install() {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "更新 yoyo"
        let label = NSTextField(labelWithString: "准备下载新版本…")
        label.frame = NSRect(x: 20, y: 80, width: 340, height: 20)
        let bar = NSProgressIndicator(frame: NSRect(x: 20, y: 52, width: 340, height: 20))
        bar.style = .bar
        bar.minValue = 0
        bar.maxValue = 100
        bar.isIndeterminate = true
        bar.startAnimation(nil)
        let detail = NSTextField(labelWithString: "")
        detail.frame = NSRect(x: 20, y: 22, width: 340, height: 20)
        detail.textColor = .secondaryLabelColor
        panel.contentView?.addSubview(label)
        panel.contentView?.addSubview(bar)
        panel.contentView?.addSubview(detail)
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        installing = panel
        var failure: String?
        var updated = false
        var finalMessage = ""
        // 命令一行一个 JSON 事件：step 做到哪一步，progress 下载了多少字节，done / error 收尾
        runCliLines(["update", "install", "--json"], line: { text in
            guard let event = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let type = event["type"] as? String else { return }
            switch type {
            case "step":
                let step = event["text"] as? String ?? ""
                label.stringValue = step
                if step.hasPrefix("取出") {
                    label.stringValue = "校验通过，正在取出新版本…"
                    detail.stringValue = ""
                    bar.isIndeterminate = true
                    bar.startAnimation(nil)
                }
            case "progress":
                let got = (event["done"] as? NSNumber)?.doubleValue ?? 0
                let total = (event["total"] as? NSNumber)?.doubleValue ?? 0
                if total > 0 {
                    let percent = min(100, got / total * 100)
                    bar.isIndeterminate = false
                    bar.doubleValue = percent
                    detail.stringValue = String(format: "%.0f%%　%@ / %@ MB", percent, megabytes(got), megabytes(total))
                } else {
                    detail.stringValue = "已下载 \(megabytes(got)) MB"
                }
            case "done":
                updated = event["updated"] as? Bool ?? false
                finalMessage = event["message"] as? String ?? ""
            case "error":
                failure = event["message"] as? String
            default:
                break
            }
        }, done: { status, errors in
            // 成功时命令已经给 app 发了 TERM：app 收好常驻进程退出，swap.sh 换好再重开
            if status == 0 && updated {
                label.stringValue = "装好了，马上重开…"
                detail.stringValue = ""
                bar.isIndeterminate = true
                bar.startAnimation(nil)
                return
            }
            panel.close()
            self.installing = nil
            if status == 0 {
                self.tell("没有要更新的", finalMessage)
            } else {
                self.tell("没更新成", failure ?? lastLines(errors, 4))
            }
        })
    }

    func tell(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // MARK: 开机自启

    /// 看一眼 config.json 的 app.launchAtLogin，跟上登录项。配置没变就什么都不做；`manual` 是用户刚在菜单里点的，出了问题要说
    func syncLoginItem(manual: Bool) {
        let stamp = configStamp()
        if !manual && stamp == seenConfig { return }
        seenConfig = stamp
        let want = configWantsLaunchAtLogin()
        loginItem.state = want ? .on : .off
        if #available(macOS 13, *) {
            if appliedLogin == want && !manual { return }
            appliedLogin = want
            applyLoginItem(want: want, manual: manual)
        }
    }

    @available(macOS 13.0, *)
    func applyLoginItem(want: Bool, manual: Bool) {
        let service = SMAppService.mainApp
        do {
            switch service.status {
            case .enabled, .requiresApproval:
                // 用户在系统设置里关掉的登录项是「要批准」，不去动它；配置里要关才取消
                if !want { try service.unregister() }
            case .notRegistered, .notFound:
                if want { try service.register() }
            @unknown default:
                break
            }
        } catch {
            appendLog("登录项没改成：\(error.localizedDescription)")
            if manual { tell("开机自启没设成", "\(error.localizedDescription)\n\n要把 yoyo 放在「应用程序」里再试。") }
            return
        }
        if want && service.status == .requiresApproval {
            appendLog("登录项要在 系统设置 > 通用 > 登录项 里允许")
            if manual { tell("还差一步", "到 系统设置 > 通用 > 登录项，把 yoyo 打开。") }
        }
    }

    /// 菜单里点「开机时打开」：改的是 config.json，和工作台的设置页是同一项，改完马上跟上
    @objc func toggleLoginItem() {
        let target = loginItem.state == .on ? "off" : "on"
        runCli(["app", "login", target]) { status, text in
            if status != 0 {
                self.tell("没改成", lastLines(text, 4))
                return
            }
            self.syncLoginItem(manual: true)
        }
    }

    // MARK: 菜单

    @objc func openConfig() { openText(configFile) }
    @objc func openLog() { openText(logFile) }

    func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 yoyo", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        updateItem = item("检查更新…", #selector(checkUpdateFromMenu))
        appMenu.addItem(updateItem)
        appMenu.addItem(.separator())
        if #available(macOS 13, *) {
            loginItem = item("开机时打开", #selector(toggleLoginItem))
        } else {
            loginItem = NSMenuItem(title: "开机时打开（要 macOS 13 以上）", action: nil, keyEquivalent: "")
            loginItem.isEnabled = false
        }
        appMenu.addItem(loginItem)
        appMenu.addItem(item("打开配置", #selector(openConfig), ","))
        appMenu.addItem(item("打开日志", #selector(openLog)))
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 yoyo", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 yoyo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        main.addItem(appItem)

        // 管理页里的输入框要能复制粘贴
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem()
        editItem.submenu = edit
        main.addItem(editItem)

        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(item("工作台", #selector(showWindow), "1"))
        windowMenu.addItem(item("重新载入", #selector(reload), "r"))
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let windowItem = NSMenuItem()
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(item("工作台", #selector(showWindow)))
        menu.addItem(item(updateItem.title, #selector(checkUpdateFromMenu)))
        return menu
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
