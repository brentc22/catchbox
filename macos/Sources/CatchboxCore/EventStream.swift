import Foundation

/// Reads a text/event-stream line by line. The server only ever sends single-line
/// `data:` events, so a line is enough — but comments, `retry:` and blank lines arrive
/// too and must be skipped rather than decoded.
public enum EventStream {
    public static func event(fromLine line: String) -> ServerEvent? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard let data = payload.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(ServerEvent.self, from: data)
    }
}
