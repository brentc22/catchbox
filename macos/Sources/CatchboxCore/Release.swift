import Foundation

/// A GitHub release, as `GET /repos/{owner}/{repo}/releases/latest` returns it — only the
/// fields the updater needs.
public struct Release: Decodable, Equatable, Sendable {
    public struct Asset: Decodable, Equatable, Sendable {
        public let name: String
        public let downloadURL: URL

        enum CodingKeys: String, CodingKey {
            case name
            case downloadURL = "browser_download_url"
        }
    }

    public let tag: String
    public let page: URL
    public let notes: String?
    public let assets: [Asset]

    enum CodingKeys: String, CodingKey {
        case tag = "tag_name"
        case page = "html_url"
        case notes = "body"
        case assets
    }

    /// The tag without its leading "v": v1.4.0 → 1.4.0.
    public var version: String { tag.hasPrefix("v") ? String(tag.dropFirst()) : tag }

    /// The app bundle the release carries — the same zip the Homebrew cask downloads.
    public var appArchive: URL? {
        assets.first { $0.name == "Catchbox-\(version).zip" }?.downloadURL
    }
}

/// Whether `candidate` is a later version than `current`, compared number by number, so
/// 1.10.0 is later than 1.9.0. A pre-release (1.4.0-beta) is never offered as an update, but
/// someone on 1.4.0-beta is offered 1.4.0 itself.
public func isNewer(_ candidate: String, than current: String) -> Bool {
    guard !candidate.contains("-") else { return false }
    let numbers = { (v: String) -> [Int] in
        (v.split(separator: "-").first ?? "").split(separator: ".").map { Int($0) ?? 0 }
    }
    let a = numbers(candidate), b = numbers(current)
    for i in 0..<max(a.count, b.count) {
        let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
        if x != y { return x > y }
    }
    return current.contains("-") // same numbers: the release is newer than its own pre-release
}
