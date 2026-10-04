import AppKit

let app = NSApplication.shared
// A regular app: Dock icon (with the unread badge), menus, ⌘Tab. The tray in the menu
// bar stays when the window closes, the way a mail client keeps running.
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
