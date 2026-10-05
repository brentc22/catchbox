import Foundation
import CatchboxCore

// A plain executable instead of XCTest: the Command Line Tools ship without it, and
// `make test` has to work on a machine that only has those.

var failures = 0
@MainActor func check(_ condition: @autoclosure () -> Bool, _ name: String, line: Int = #line) {
    if condition() {
        print("✔ \(name)")
    } else {
        failures += 1
        print("✖ \(name)  (line \(line))")
    }
}

// --- event stream ------------------------------------------------------------
check(EventStream.event(fromLine: #"data: {"type":"mail","account":"a1","id":"m9"}"#)
        == ServerEvent(type: .mail, account: "a1", id: "m9"),
      "a mail event names the mailbox and the message")
check(EventStream.event(fromLine: #"data: {"type":"accounts"}"#)?.type == .accounts,
      "an accounts event needs no mailbox")
check(EventStream.event(fromLine: "retry: 3000") == nil, "retry lines are not events")
check(EventStream.event(fromLine: "") == nil, "blank lines are not events")
check(EventStream.event(fromLine: #"data: {"type":"reboot"}"#) == nil,
      "an unknown event type is skipped, not misread")

// --- node ---------------------------------------------------------------------
do {
    // Finder hands an app launchd's PATH, which has no node in it.
    let locator = NodeLocator(environment: ["PATH": "/usr/bin:/bin"], home: "/Users/dev",
                              isExecutable: { $0 == "/opt/homebrew/bin/node" })
    check(locator.locate() == "/opt/homebrew/bin/node", "Homebrew's node is found without it on PATH")
}
do {
    let locator = NodeLocator(environment: ["PATH": "/custom/bin", "CATCHBOX_NODE": "/pinned/node"],
                              home: "/Users/dev", isExecutable: { _ in true })
    check(locator.locate() == "/pinned/node", "CATCHBOX_NODE wins over everything")
}
do {
    let locator = NodeLocator(environment: ["PATH": "/opt/homebrew/bin"], home: "/Users/dev",
                              isExecutable: { _ in false })
    check(locator.locate() == nil, "no node anywhere is reported as nil")
    check(locator.candidates.filter { $0 == "/opt/homebrew/bin/node" }.count == 1,
          "a directory on PATH and in the defaults is tried once")
}

// --- models -------------------------------------------------------------------
do {
    let json = #"""
    {"demo":false,"current":"b","accounts":[
      {"id":"a","address":"signup-x@uberip.com","label":"Signup flow","createdAt":"x","unread":2,"total":3},
      {"id":"b","address":"billing-y@uberip.com","label":null,"createdAt":"x","unread":1,"total":1}]}
    """#
    let payload = try! JSONDecoder().decode(AccountsPayload.self, from: Data(json.utf8))
    check(payload.active?.id == "b", "the active mailbox is the one the server calls current")
    check(payload.totalUnread == 3, "unread adds up across mailboxes")
    check(payload.accounts[0].displayName == "Signup flow", "a named mailbox goes by its name")
    check(payload.accounts[1].displayName == "billing-y", "an unnamed one by its local part")
}
check(badgeLabel(unread: 0) == nil, "no badge for an empty inbox")
check(badgeLabel(unread: 7) == "7", "a small count is shown as is")
check(badgeLabel(unread: 250) == "99+", "a large count is capped")

// --- updates ------------------------------------------------------------------
check(isNewer("1.4.0", than: "1.3.0"), "a minor bump is an update")
check(isNewer("1.10.0", than: "1.9.2"), "versions compare as numbers, not text")
check(isNewer("2.0", than: "1.9.9"), "a shorter version still compares")
check(!isNewer("1.3.0", than: "1.3.0"), "the same version is not an update")
check(!isNewer("1.2.9", than: "1.3.0"), "an older release is not an update")
check(!isNewer("1.4.0-beta.1", than: "1.3.0"), "a pre-release is never offered")
check(isNewer("1.4.0", than: "1.4.0-beta.1"), "a release is offered to whoever runs its pre-release")
do {
    let json = #"""
    {"tag_name":"v1.4.0","html_url":"https://github.com/brentc22/catchbox/releases/tag/v1.4.0",
     "body":"Updates itself.","assets":[
       {"name":"Catchbox-1.3.0.zip","browser_download_url":"https://example.com/old.zip"},
       {"name":"Catchbox-1.4.0.zip","browser_download_url":"https://example.com/new.zip"}]}
    """#
    let release = try! JSONDecoder().decode(Release.self, from: Data(json.utf8))
    check(release.version == "1.4.0", "the tag's v is dropped")
    check(release.appArchive?.absoluteString == "https://example.com/new.zip",
          "the archive is the one for this release's version")
}
do {
    let json = #"{"tag_name":"v1.4.0","html_url":"https://x.dev","body":null,"assets":[]}"#
    let release = try! JSONDecoder().decode(Release.self, from: Data(json.utf8))
    check(release.appArchive == nil, "a release without the app zip offers nothing to install")
}

// --- port ---------------------------------------------------------------------
if let port = freeLoopbackPort() {
    check(port > 1024, "a free port is an unprivileged one")
} else {
    check(false, "a free loopback port can be found")
}

print(failures == 0 ? "\nall passed" : "\n\(failures) failed")
exit(failures == 0 ? 0 : 1)
