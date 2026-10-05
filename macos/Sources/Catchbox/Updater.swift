import AppKit
import CatchboxCore

/// Keeps catchbox current without Homebrew or the Mac App Store. It asks GitHub for the
/// latest release now and then; when there is a newer one it says so once — a notification
/// and an entry in the tray — and on a click downloads that release's app, checks it is
/// really catchbox at that version with an intact signature, swaps it in and restarts.
///
/// The mailboxes live in ~/.config/testmail, outside the bundle, so an update never touches them.
@MainActor
final class Updater {
    // CATCHBOX_UPDATE_FEED points the check at a release JSON of your own, to try an update
    // end to end without publishing one.
    private static let latest = ProcessInfo.processInfo.environment["CATCHBOX_UPDATE_FEED"]
        .flatMap(URL.init(string:))
        ?? URL(string: "https://api.github.com/repos/brentc22/catchbox/releases/latest")!
    private static let interval: TimeInterval = 6 * 60 * 60
    private static let skippedKey = "skippedUpdateVersion"
    private static let announcedKey = "announcedUpdateVersion"

    /// A newer release, once one has been found. The tray offers it for as long as it is set.
    private(set) var available: Release?
    private(set) var installing = false
    var onChange: (() -> Void)?
    /// Called once per new version, to announce it outside the app.
    var onFound: ((Release) -> Void)?

    let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    private var timer: Timer?
    private var offering = false

    func start() {
        // `swift run` has no bundle and so no version to compare; it would always "find" one.
        guard Bundle.main.bundleIdentifier != nil, current != "0" else { return }
        Task { await check(userInitiated: false) }
        timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.check(userInitiated: false) }
        }
    }

    // MARK: - checking

    /// From the timer: quiet unless there is something new. From the menu: always answers.
    func check(userInitiated: Bool) async {
        let release: Release
        do {
            release = try await fetchLatest()
        } catch {
            if userInitiated { tell("Could not check for updates", "\(error.localizedDescription)") }
            return
        }

        guard isNewer(release.version, than: current), release.appArchive != nil else {
            available = nil
            onChange?()
            if userInitiated { tell("catchbox is up to date", "Version \(current) is the latest.") }
            return
        }

        // A version you said to skip stays out of the tray too, until a later one comes —
        // unless you ask yourself, through Check for Updates….
        let defaults = UserDefaults.standard
        if !userInitiated, defaults.string(forKey: Self.skippedKey) == release.version {
            available = nil
            onChange?()
            return
        }

        available = release
        onChange?()
        if userInitiated { return offer(release) }

        // One announcement per version — a check every six hours must not turn into a
        // notification every six hours.
        guard defaults.string(forKey: Self.announcedKey) != release.version else { return }
        defaults.set(release.version, forKey: Self.announcedKey)
        onFound?(release)
    }

    private func fetchLatest() async throws -> Release {
        var request = URLRequest(url: Self.latest)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("catchbox/\(current)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw Failure.unreachable((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return try JSONDecoder().decode(Release.self, from: data)
    }

    // MARK: - offering

    /// The question, with the release notes, behind the notification and the tray entry.
    func offerAvailable() {
        if let available { offer(available) } else { Task { await check(userInitiated: true) } }
    }

    private func offer(_ release: Release) {
        if installing { return tell("Installing catchbox \(release.version)…", "catchbox restarts by itself when it is done.") }
        // A click on the notification while this question is already open must not stack a second one.
        guard !offering else { return }
        offering = true
        defer { offering = false }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "catchbox \(release.version) is available"
        let notes = (release.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        alert.informativeText = "You have \(current)."
            + (notes.isEmpty ? "" : "\n\n" + String(notes.prefix(700)) + (notes.count > 700 ? "…" : ""))
        alert.addButton(withTitle: "Update and Restart")
        alert.addButton(withTitle: "Later")
        alert.addButton(withTitle: "Skip This Version")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            Task { await install(release) }
        case .alertThirdButtonReturn:
            UserDefaults.standard.set(release.version, forKey: Self.skippedKey)
            available = nil
            onChange?()
        default:
            break
        }
    }

    // MARK: - installing

    private func install(_ release: Release) async {
        guard let archive = release.appArchive else { return }
        installing = true
        onChange?()

        let fm = FileManager.default
        let target = Bundle.main.bundleURL
        do {
            // A scratch directory on the same volume as the app, so the swap below is a rename
            // and not a copy that could be cut off halfway.
            let scratch = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask,
                                     appropriateFor: target, create: true)
            defer { try? fm.removeItem(at: scratch) }

            guard Self.trusted(archive) else { throw Failure.untrustedSource(archive.host ?? "?") }
            let (download, response) = try await URLSession.shared.download(from: archive)
            // The async download leaves its file behind, unlike the completion-handler one.
            defer { try? fm.removeItem(at: download) }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw Failure.unreachable((response as? HTTPURLResponse)?.statusCode ?? 0)
            }
            try await run("/usr/bin/ditto", "-x", "-k", download.path, scratch.path)

            // Only ever swap in catchbox, at the version that was offered, with a signature that
            // is intact — which catches a damaged download. It does not prove who built it: the
            // app is signed ad hoc, not with a Developer ID, so that trust rests on the download
            // coming from this repository's releases over HTTPS (see `trusted`).
            let fresh = scratch.appendingPathComponent("Catchbox.app")
            guard let bundle = Bundle(url: fresh),
                  bundle.bundleIdentifier == Bundle.main.bundleIdentifier,
                  bundle.infoDictionary?["CFBundleShortVersionString"] as? String == release.version
            else { throw Failure.notCatchbox }
            try await run("/usr/bin/codesign", "--verify", "--deep", "--strict", fresh.path)
            // Downloads by URLSession are not quarantined today; this keeps it that way if
            // that ever changes — the app is not notarised, so Gatekeeper would refuse it.
            try? await run("/usr/bin/xattr", "-dr", "com.apple.quarantine", fresh.path)

            _ = try fm.replaceItemAt(target, withItemAt: fresh)
        } catch {
            installing = false
            onChange?()
            return failed(release, error)
        }
        // `installing` stays set from here on: the new copy is in place and this one is about
        // to quit, so the tray must not offer the same update a second time.
        relaunch(target)
    }

    /// Starts the new copy first, then quits this one. A helper process that waits for this
    /// one to exit and then opens the new copy does not work: macOS ends it along with the
    /// app. So the new copy is launched as a second instance, told which process it replaces,
    /// and waits for that one to go before the single-instance rule looks.
    private func relaunch(_ app: URL) {
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.arguments = [Self.replacingFlag, String(ProcessInfo.processInfo.processIdentifier)]
        NSWorkspace.shared.openApplication(at: app, configuration: config) { _, error in
            Task { @MainActor in
                if let error {
                    self.tell("catchbox was updated", "Open it again to use the new version. (\(error.localizedDescription))")
                }
                NSApp.terminate(nil)
            }
        }
    }

    /// Release assets of this repository, served over HTTPS by GitHub — or anything at all
    /// while CATCHBOX_UPDATE_FEED is set, which only someone at this Mac can do.
    static func trusted(_ url: URL) -> Bool {
        if ProcessInfo.processInfo.environment["CATCHBOX_UPDATE_FEED"] != nil { return true }
        return url.scheme == "https" && url.host == "github.com"
            && url.path.hasPrefix("/brentc22/catchbox/releases/download/")
    }

    static let replacingFlag = "--replacing"

    /// In the new copy, at launch: the process it replaces, if it was started by an update.
    static func predecessor(arguments: [String] = CommandLine.arguments) -> pid_t? {
        guard let flag = arguments.firstIndex(of: replacingFlag), flag + 1 < arguments.count else { return nil }
        return pid_t(arguments[flag + 1])
    }

    /// Waits, without blocking the main thread, for that process to have quit — so the two
    /// never run a server side by side. Bounded, so a predecessor that hangs while quitting
    /// cannot keep the new copy from starting.
    static func waitForExit(of pid: pid_t) async {
        let deadline = Date().addingTimeInterval(10)
        while kill(pid, 0) == 0, Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func failed(_ release: Release, _ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "The update could not be installed"
        alert.informativeText = "\(error.localizedDescription)\n\nYou can download catchbox \(release.version) from its release page instead."
        alert.addButton(withTitle: "Open Release Page")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(release.page) }
    }

    private func tell(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.runModal()
    }

    /// Runs a system tool off the main thread and throws if it fails.
    private func run(_ tool: String, _ arguments: String...) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: tool)
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { p in
                p.terminationStatus == 0
                    ? done.resume()
                    : done.resume(throwing: Failure.tool((tool as NSString).lastPathComponent, p.terminationStatus))
            }
            do { try process.run() } catch { done.resume(throwing: error) }
        }
    }

    enum Failure: LocalizedError {
        case unreachable(Int)
        case notCatchbox
        case untrustedSource(String)
        case tool(String, Int32)

        var errorDescription: String? {
            switch self {
            case .unreachable(let status): "GitHub did not answer (HTTP \(status))."
            case .notCatchbox: "The download was not the catchbox version that was offered."
            case .untrustedSource(let host): "The update would come from \(host), not from catchbox's GitHub releases."
            case .tool(let name, let status): "\(name) failed with status \(status)."
            }
        }
    }
}
