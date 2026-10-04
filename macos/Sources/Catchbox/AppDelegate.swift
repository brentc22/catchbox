import AppKit
import CatchboxCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var server: ServerProcess?
    private var api: LocalAPI?
    private var window: InboxWindowController?
    private var statusItem: StatusItemController?
    private let notifier = Notifier()
    private var feed: Task<Void, Never>?

    private var accounts: AccountsPayload?
    private var latest: Message? // the newest mail in the active mailbox
    private var restarts = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One copy at a time: a second one would start a second server and a second tray.
        let own = ProcessInfo.processInfo.processIdentifier
        if let id = Bundle.main.bundleIdentifier,
           let other = NSRunningApplication.runningApplications(withBundleIdentifier: id)
               .first(where: { $0.processIdentifier != own }) {
            other.activate()
            NSApp.terminate(nil)
            return
        }

        NSApp.mainMenu = MainMenu.build(target: self)
        notifier.onCopy = { [weak self] code in self?.copy(code, announce: false) }
        notifier.onOpen = { [weak self] id, account in
            self?.window?.show()
            self?.window?.open(message: id, account: account)
        }
        notifier.setUp()

        statusItem = StatusItemController(actions: .init(
            copyAddress: { [weak self] in self?.copyAddress() },
            copyCode: { [weak self] in self?.copyLatestCode() },
            openLink: { [weak self] in self?.openLatestLink() },
            openInbox: { [weak self] in self?.showInbox() },
            newMailbox: { [weak self] in self?.newMailbox() },
            toggleNotifications: { [weak self] in self?.toggleNotifications() },
            quit: { NSApp.terminate(nil) }
        ))

        Task { await launchServer() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        feed?.cancel()
        server?.stop()
    }

    // Closing the window keeps catchbox in the menu bar; clicking the Dock icon brings it back.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showInbox() }
        return true
    }

    // MARK: - server

    private func launchServer() async {
        do {
            let server = try ServerProcess()
            server.onUnexpectedExit = { [weak self] log in self?.serverDied(log) }
            try await server.start()
            self.server = server
            let api = LocalAPI(base: server.baseURL)
            self.api = api
            window = InboxWindowController(base: server.baseURL)
            window?.show()
            listen(api)
        } catch {
            fail(error)
        }
    }

    private func serverDied(_ log: String) {
        feed?.cancel()
        // A crash should not cost you the app. Twice is an accident; a third time is a
        // bug worth seeing.
        if restarts < 2 {
            restarts += 1
            window?.close()
            window = nil
            Task { await launchServer() }
        } else {
            fail(ServerProcess.Failure.didNotStart(log))
        }
    }

    private func fail(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        switch error {
        case ServerProcess.Failure.noNode:
            alert.messageText = "catchbox needs Node.js"
            alert.informativeText = "It runs the same inbox as the catchbox command, which is written for Node 18 or newer. Install it with:\n\n    brew install node\n\nthen open catchbox again."
        case ServerProcess.Failure.didNotStart(let log):
            alert.messageText = "The inbox server stopped"
            alert.informativeText = String(log.suffix(1200))
        default:
            alert.messageText = "catchbox could not start"
            alert.informativeText = "\(error)"
        }
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    // MARK: - live updates

    /// Follows the server's push stream for the badge, the tray and notifications. The
    /// web inbox has its own connection to the same stream; this one never marks mail read.
    private func listen(_ api: LocalAPI) {
        feed?.cancel()
        feed = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                do {
                    for try await event in try await api.events() {
                        await self?.handle(event)
                    }
                } catch {}
                try? await Task.sleep(nanoseconds: 2_000_000_000) // dropped; reconnect
            }
        }
    }

    private func handle(_ event: ServerEvent) async {
        guard let api else { return }
        if event.type == .mail, let account = event.account, let id = event.id {
            let messages = (try? await api.inbox(account: account)) ?? []
            if let message = messages.first(where: { $0.id == id }) {
                await refresh()
                notifier.post(message, mailbox: accounts?.accounts.first { $0.id == account })
                return
            }
        }
        await refresh()
    }

    private func refresh() async {
        guard let api else { return }
        guard let accounts = try? await api.accounts() else { return }
        self.accounts = accounts
        if let active = accounts.active {
            latest = (try? await api.inbox(account: active.id))?.first
        } else {
            latest = nil
        }
        NSApp.dockTile.badgeLabel = badgeLabel(unread: accounts.totalUnread)
        window?.setSubtitle(accounts.active?.address ?? "")
        statusItem?.update(accounts: accounts, latest: latest, notificationsOn: notifier.enabled)
    }

    // MARK: - actions (menus and the tray)

    private func copy(_ text: String, announce: Bool = true) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        if announce { NSSound(named: "Pop")?.play() }
    }

    @objc func showInbox() { window?.show() }

    @objc func showSettings() {
        window?.show()
        window?.press(",")
    }

    @objc func newMailbox() {
        window?.show()
        window?.newMailbox()
    }

    @objc func copyAddress() {
        if let address = accounts?.active?.address { copy(address) } else { NSSound.beep() }
    }

    @objc func copyLatestCode() {
        Task {
            await refresh() // the tray may be a few seconds behind; the code must not be
            if let code = latest?.code { copy(code) } else { NSSound.beep() }
        }
    }

    @objc func openLatestLink() {
        if let link = latest?.actionableLinks.first, let url = URL(string: link) {
            NSWorkspace.shared.open(url)
        } else {
            NSSound.beep()
        }
    }

    @objc func showAllMailboxes() {
        window?.show()
        window?.press("g")
        window?.press("a")
    }

    @objc func focusFilter() {
        window?.show()
        window?.press("/")
    }

    @objc func reloadInbox() { window?.reload() }

    private func toggleNotifications() {
        notifier.enabled.toggle()
        if notifier.enabled { notifier.setUp() }
        statusItem?.update(accounts: accounts, latest: latest, notificationsOn: notifier.enabled)
    }
}
