import Foundation
import CatchboxCore

/// The few calls the native side makes to the local server. Everything else is the web
/// inbox's business.
struct LocalAPI: Sendable {
    let base: URL

    private func get<T: Decodable>(_ path: String, _ query: [URLQueryItem] = []) async throws -> T {
        var url = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { url.queryItems = query }
        let (data, _) = try await URLSession.shared.data(from: url.url!)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func accounts() async throws -> AccountsPayload {
        try await get("api/accounts")
    }

    /// The inbox list, which — unlike opening a message — does not mark anything as read.
    func inbox(account: String) async throws -> [Message] {
        let payload: InboxPayload = try await get("api/inbox", [URLQueryItem(name: "account", value: account)])
        return payload.messages
    }

    /// Pushes from the server, one per line, until the connection drops.
    func events() async throws -> AsyncThrowingStream<ServerEvent, Error> {
        let (bytes, _) = try await URLSession.shared.bytes(from: base.appendingPathComponent("api/events"))
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await line in bytes.lines {
                        if let event = EventStream.event(fromLine: line) { continuation.yield(event) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
