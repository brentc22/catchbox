import AppKit
import CatchboxCore

/// The tray in the menu bar: unread count at a glance, and the two things you come for —
/// the address to paste into a signup form, and the code that comes back — one click away
/// without bringing the window up.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    struct Actions {
        var copyAddress: () -> Void
        var copyCode: () -> Void
        var openLink: () -> Void
        var openInbox: () -> Void
        var newMailbox: () -> Void
        var toggleNotifications: () -> Void
        var quit: () -> Void
    }

    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let actions: Actions
    private var accounts: AccountsPayload?
    private var latest: Message?
    private var notificationsOn = true

    init(actions: Actions) {
        self.actions = actions
        super.init()
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        render()
    }

    func update(accounts: AccountsPayload?, latest: Message?, notificationsOn: Bool) {
        self.accounts = accounts
        self.latest = latest
        self.notificationsOn = notificationsOn
        render()
    }

    private func render() {
        guard let button = item.button else { return }
        let unread = accounts?.totalUnread ?? 0
        let symbol = unread > 0 ? "tray.full.fill" : "tray"
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "catchbox")
        button.image?.isTemplate = true
        button.imagePosition = .imageLeading
        button.title = badgeLabel(unread: unread).map { " \($0)" } ?? ""
        button.toolTip = unread > 0 ? "catchbox — \(unread) unread" : "catchbox"
    }

    // Built when it opens, so it always shows the current address and the newest code.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        if let active = accounts?.active {
            let header = NSMenuItem(title: active.displayName, action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            menu.addItem(entry("Copy \(active.address)", #selector(copyAddress)))
        } else {
            let none = NSMenuItem(title: "No mailbox yet", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }

        if let code = latest?.code {
            menu.addItem(entry("Copy Code  \(code)", #selector(copyCode)))
        } else {
            let none = NSMenuItem(title: "No code in the latest mail", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        if latest?.actionableLinks.first != nil {
            menu.addItem(entry("Open Link from \(latest!.sender)", #selector(openLink)))
        }

        menu.addItem(.separator())
        menu.addItem(entry("Open Inbox", #selector(openInbox)))
        menu.addItem(entry("New Mailbox", #selector(newMailbox)))
        menu.addItem(.separator())
        let notify = entry("Notify When Mail Arrives", #selector(toggleNotifications))
        notify.state = notificationsOn ? .on : .off
        menu.addItem(notify)
        menu.addItem(.separator())
        menu.addItem(entry("Quit catchbox", #selector(quit), key: "q"))
    }

    private func entry(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func copyAddress() { actions.copyAddress() }
    @objc private func copyCode() { actions.copyCode() }
    @objc private func openLink() { actions.openLink() }
    @objc private func openInbox() { actions.openInbox() }
    @objc private func newMailbox() { actions.newMailbox() }
    @objc private func toggleNotifications() { actions.toggleNotifications() }
    @objc private func quit() { actions.quit() }
}
