import AppKit
import UserNotifications
import CatchboxCore

/// Native notifications for new mail, with the code in them and a button that copies it —
/// so the usual "wait for the OTP" moment never needs the window at all.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private static let category = "mail"
    private static let copyAction = "copy-code"
    private static let enabledKey = "notifyOnMail"
    private static let updateCategory = "update"
    private static let updateAction = "install-update"

    /// A tap on the notification itself: open that message.
    var onOpen: ((_ id: String, _ account: String?) -> Void)?
    var onCopy: ((String) -> Void)?
    /// A tap on the update notification, or its Update button: show the offer.
    var onUpdate: (() -> Void)?

    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    private var center: UNUserNotificationCenter? {
        // UNUserNotificationCenter traps outside an app bundle, which is what `swift run` is.
        Bundle.main.bundleIdentifier == nil ? nil : .current()
    }

    func setUp() {
        guard let center else { return }
        center.delegate = self
        let copy = UNNotificationAction(identifier: Self.copyAction, title: "Copy Code")
        let update = UNNotificationAction(identifier: Self.updateAction, title: "Update")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.category, actions: [copy], intentIdentifiers: []),
            UNNotificationCategory(identifier: Self.updateCategory, actions: [update], intentIdentifiers: []),
        ])
        if enabled { center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in } }
    }

    func post(_ message: Message, mailbox: Mailbox?) {
        guard enabled, let center else { return }
        let content = UNMutableNotificationContent()
        content.title = message.subject.isEmpty ? "(no subject)" : message.subject
        content.subtitle = [message.sender, mailbox?.displayName].compactMap { $0 }.joined(separator: " → ")
        content.body = message.code.map { "Code \($0)" } ?? (message.actionableLinks.first ?? "")
        content.sound = .default
        content.threadIdentifier = message.account ?? "mail"
        var info: [String: String] = ["id": message.id]
        if let account = message.account { info["account"] = account }
        if let code = message.code {
            info["code"] = code
            content.categoryIdentifier = Self.category
        }
        content.userInfo = info
        center.add(UNNotificationRequest(identifier: message.id, content: content, trigger: nil))
    }

    /// Not tied to "Notify When Mail Arrives": that switch is about mail, and an update is
    /// announced once per version anyway.
    func postUpdate(version: String, current: String) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = "catchbox \(version) is available"
        content.body = "You have \(current). Click to update — your mailboxes stay as they are."
        content.categoryIdentifier = Self.updateCategory
        content.userInfo = ["update": version]
        center.add(UNNotificationRequest(identifier: "update-\(version)", content: content, trigger: nil))
    }

    // While the window is in front, the inbox shows new mail itself; a banner on top of
    // it is a second announcement of the same thing.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await MainActor.run { NSApp.isActive } ? [] : [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let id = info["id"] as? String
        let account = info["account"] as? String
        let code = info["code"] as? String
        let action = response.actionIdentifier
        let isUpdate = info["update"] != nil
        await MainActor.run {
            if isUpdate {
                if action != UNNotificationDismissActionIdentifier { self.onUpdate?() }
            } else if action == Self.copyAction, let code {
                self.onCopy?(code)
            } else if let id {
                self.onOpen?(id, account)
            }
        }
    }
}
