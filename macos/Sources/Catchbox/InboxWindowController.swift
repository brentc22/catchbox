import AppKit
import WebKit

/// The main window: the same inbox `catchbox ui` serves, in a WKWebView, with the seams
/// a browser tab would paper over taken care of natively — links open in your browser,
/// attachments land in Downloads, confirm() is a real sheet, copying uses the pasteboard.
@MainActor
final class InboxWindowController: NSWindowController, NSWindowDelegate {
    private let webView: WKWebView
    private let base: URL
    private let bridge = Bridge()

    init(base: URL) {
        self.base = base

        let config = WKWebViewConfiguration()
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: Self.bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(bridge, name: "catchbox")
        config.userContentController = content
        config.websiteDataStore = .default() // keeps the inbox's own settings between launches

        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground") // no white flash before the dark theme paints

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "catchbox"
        window.minSize = NSSize(width: 420, height: 480)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.center()
        window.setFrameAutosaveName("Inbox")

        super.init(window: window)
        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.load(URLRequest(url: base))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    // Runs before the inbox's own script. It tells the page it is inside the app, and
    // routes clipboard writes to the native pasteboard: WebKit only allows them inside a
    // user gesture, and "New mailbox" copies the address after a network round trip.
    private static let bootstrap = """
    window.catchboxApp = { version: 1 };
    (() => {
      const post = (msg) => window.webkit.messageHandlers.catchbox.postMessage(msg);
      const clip = navigator.clipboard || {};
      clip.writeText = (text) => { post({ type: "copy", text: String(text) }); return Promise.resolve(); };
      try { Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true }); } catch {}
    })();
    """

    func show() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func setSubtitle(_ text: String) {
        window?.subtitle = text
    }

    func reload() { webView.reload() }

    /// Shortcuts the page already understands, sent as the key press it listens for.
    func press(_ key: String) {
        run("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: \(json(key)), bubbles: true }))")
    }

    func newMailbox() {
        run("document.getElementById('add-box')?.click()")
    }

    /// Open one message, e.g. from a notification that was clicked.
    func open(message id: String, account: String?) {
        let detail = "{ id: \(json(id)), account: \(json(account ?? "")) }"
        run("window.dispatchEvent(new CustomEvent('catchbox:open', { detail: \(detail) }))")
    }

    private func run(_ js: String) {
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func json(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let array = data.map { String(decoding: $0, as: UTF8.self) } ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }

    /// Anything that leaves the local server goes to the default browser, not into the app.
    fileprivate func isLocal(_ url: URL) -> Bool {
        url.host == base.host && url.port == base.port
    }
}

// MARK: - JavaScript → native

@MainActor
private final class Bridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "copy", let text = body["text"] as? String {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }
}

// MARK: - navigation, popups and downloads

extension InboxWindowController: WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        // The rendered mail lives in an about:srcdoc frame; let it load, but send any
        // click out of it — and every other external link — to the browser.
        if url.scheme == "about" || url.scheme == "data" { return decisionHandler(.allow) }
        if isLocal(url) {
            return decisionHandler(action.shouldPerformDownload ? .download : .allow)
        }
        if action.targetFrame?.isMainFrame == true || action.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow) // subresources inside the mail: images, fonts
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        // Attachments come with `content-disposition: attachment`; the server never lets
        // the page display one inline, and neither does the app.
        let disposition = (response.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let download = disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType
        decisionHandler(download ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        completionHandler(Self.unused(in: downloads, name: suggestedFilename))
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }

    /// invoice.pdf, then invoice 2.pdf — the way Finder names a second copy.
    private static func unused(in dir: URL, name: String) -> URL {
        let fm = FileManager.default
        let safe = name.replacingOccurrences(of: "/", with: "-")
        var url = dir.appendingPathComponent(safe.isEmpty ? "attachment" : safe)
        let stem = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        var n = 2
        while fm.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        return url
    }

    // target="_blank" and window.open(): a new window would be an empty WKWebView the app
    // never shows. Open the link where links belong.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let lines = message.components(separatedBy: "\n")
        let alert = NSAlert()
        alert.messageText = lines.first ?? message
        alert.informativeText = lines.dropFirst().joined(separator: "\n")
        alert.alertStyle = .warning
        let ok = alert.addButton(withTitle: message.lowercased().hasPrefix("delete") ? "Delete" : "OK")
        ok.hasDestructiveAction = message.lowercased().hasPrefix("delete")
        alert.addButton(withTitle: "Cancel")
        guard let window else { return completionHandler(alert.runModal() == .alertFirstButtonReturn) }
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        guard let window else { alert.runModal(); return completionHandler() }
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload() // WebKit dropped the page under memory pressure; bring it back
    }
}
