import Foundation

/// Finds a `node` to run the server with.
///
/// An app opened from Finder or the Dock does not get your shell's PATH — it gets
/// launchd's, which is /usr/bin:/bin:/usr/sbin:/sbin. So `node` from Homebrew, Volta or
/// nvm is invisible unless we go looking in the places those tools put it.
public struct NodeLocator {
    public var environment: [String: String]
    public var home: String
    public var isExecutable: (String) -> Bool

    public init(environment: [String: String] = ProcessInfo.processInfo.environment,
                home: String = NSHomeDirectory(),
                isExecutable: @escaping (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) {
        self.environment = environment
        self.home = home
        self.isExecutable = isExecutable
    }

    /// Every place worth trying, most specific first. An explicit override wins, then
    /// whatever PATH we did get, then the usual install locations.
    public var candidates: [String] {
        var list: [String] = []
        if let explicit = environment["CATCHBOX_NODE"], !explicit.isEmpty { list.append(explicit) }
        for dir in (environment["PATH"] ?? "").split(separator: ":") {
            list.append("\(dir)/node")
        }
        list += [
            "/opt/homebrew/bin/node",        // Homebrew, Apple silicon
            "/usr/local/bin/node",           // Homebrew, Intel; the nodejs.org installer
            "\(home)/.volta/bin/node",
            "\(home)/.local/share/fnm/aliases/default/bin/node",
            "\(home)/.nvm/current/bin/node",
        ]
        var seen = Set<String>()
        return list.filter { seen.insert($0).inserted }
    }

    public func locate() -> String? {
        candidates.first(where: isExecutable)
    }
}
