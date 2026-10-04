import Foundation

// The shapes the local server sends. Only the fields the app itself uses are decoded;
// the web inbox reads the rest.

public struct Mailbox: Decodable, Equatable, Sendable {
    public let id: String
    public let address: String
    public let label: String?
    public let unread: Int

    public init(id: String, address: String, label: String?, unread: Int) {
        self.id = id
        self.address = address
        self.label = label
        self.unread = unread
    }

    /// What a person calls this mailbox: its name, or the part of the address before the @.
    public var displayName: String {
        if let label, !label.isEmpty { return label }
        return String(address.split(separator: "@").first ?? Substring(address))
    }
}

public struct AccountsPayload: Decodable, Equatable, Sendable {
    public let demo: Bool
    public let current: String?
    public let accounts: [Mailbox]

    public init(demo: Bool, current: String?, accounts: [Mailbox]) {
        self.demo = demo
        self.current = current
        self.accounts = accounts
    }

    public var active: Mailbox? {
        accounts.first { $0.id == current } ?? accounts.first
    }

    public var totalUnread: Int { accounts.reduce(0) { $0 + $1.unread } }
}

public struct Message: Decodable, Equatable, Sendable {
    public let id: String
    public let account: String?
    public let from: String?
    public let fromName: String?
    public let subject: String
    public let code: String?
    public let actionableLinks: [String]

    public init(id: String, account: String?, from: String?, fromName: String?,
                subject: String, code: String?, actionableLinks: [String]) {
        self.id = id
        self.account = account
        self.from = from
        self.fromName = fromName
        self.subject = subject
        self.code = code
        self.actionableLinks = actionableLinks
    }

    public var sender: String { fromName ?? from ?? "Unknown sender" }
}

public struct InboxPayload: Decodable, Sendable {
    public let messages: [Message]
}

/// One push from the server's /api/events stream.
public struct ServerEvent: Decodable, Equatable, Sendable {
    public enum Kind: String, Decodable, Sendable { case mail, accounts, counts }
    public let type: Kind
    public let account: String?
    public let id: String?

    public init(type: Kind, account: String? = nil, id: String? = nil) {
        self.type = type
        self.account = account
        self.id = id
    }
}

/// The Dock and the menu bar both show this. A badge that reads "1,204" is noise; past
/// 99 the exact number stops mattering.
public func badgeLabel(unread: Int) -> String? {
    if unread <= 0 { return nil }
    return unread > 99 ? "99+" : String(unread)
}
