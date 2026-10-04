import AppKit
import CatchboxCore

/// The catchbox server, run by the app as a child process.
///
/// The app is a window onto the same server `catchbox ui` runs — one implementation of
/// mail.tm, the code and link extraction and the header checks, shared with the CLI. The
/// app owns this copy: it starts it on a free port, and it takes it down when it quits.
@MainActor
final class ServerProcess {
    enum Failure: Error {
        case noNode
        case noScript
        case noPort
        case didNotStart(String)
    }

    let port: UInt16
    private let process = Process()
    private var log = ""
    private var stopping = false

    /// Called when the server exits without having been asked to, with what it last said.
    var onUnexpectedExit: ((String) -> Void)?

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    init() throws {
        guard let node = NodeLocator().locate() else { throw Failure.noNode }
        guard let script = Self.script() else { throw Failure.noScript }
        guard let port = freeLoopbackPort() else { throw Failure.noPort }
        self.port = port

        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script.path, "ui", String(port)]
        var env = ProcessInfo.processInfo.environment
        env["TESTMAIL_NO_OPEN"] = "1" // the app is the window; no browser tab as well
        env["CATCHBOX_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = String(decoding: handle.availableData, as: UTF8.self)
            Task { @MainActor in self?.append(chunk) }
        }
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.exited() }
        }
    }

    /// The JavaScript to run: the copy inside the app bundle, or — for `swift run` during
    /// development — the repository this package lives in.
    private static func script() -> URL? {
        let fm = FileManager.default
        var candidates: [URL] = []
        if let res = Bundle.main.resourceURL {
            candidates.append(res.appendingPathComponent("catchbox/bin/testmail.js"))
        }
        if let root = ProcessInfo.processInfo.environment["CATCHBOX_ROOT"] {
            candidates.append(URL(fileURLWithPath: root).appendingPathComponent("bin/testmail.js"))
        }
        // .build/<config>/Catchbox → macos/ → the repository root
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        var dir = exe.deletingLastPathComponent()
        for _ in 0..<5 {
            candidates.append(dir.appendingPathComponent("bin/testmail.js"))
            dir = dir.deletingLastPathComponent()
        }
        return candidates.first { fm.fileExists(atPath: $0.path) }
    }

    func start() async throws {
        try process.run()
        // Ready means answering, not merely running: the first request is the inbox page.
        let probe = baseURL.appendingPathComponent("api/accounts")
        for _ in 0..<100 {
            if !process.isRunning { throw Failure.didNotStart(log) }
            if let (_, res) = try? await URLSession.shared.data(from: probe),
               (res as? HTTPURLResponse)?.statusCode == 200 { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw Failure.didNotStart(log.isEmpty ? "The server did not answer within 10 seconds." : log)
    }

    func stop() {
        stopping = true
        if process.isRunning { process.terminate() }
    }

    private func append(_ chunk: String) {
        log += chunk
        if log.count > 8000 { log = String(log.suffix(4000)) }
    }

    private func exited() {
        if !stopping { onUnexpectedExit?(log) }
    }
}
