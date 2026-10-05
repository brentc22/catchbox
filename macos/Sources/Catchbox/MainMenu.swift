import AppKit

/// The menu bar menus. Edit matters more than it looks: without Cut/Copy/Paste items
/// carrying their standard selectors, ⌘V does nothing in the web view's text fields.
@MainActor
enum MainMenu {
    static func build(target: AppDelegate) -> NSMenu {
        let main = NSMenu()

        main.addItem(submenu("catchbox", [
            item("About catchbox", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: nil),
            item("Check for Updates…", #selector(AppDelegate.checkForUpdates), target: target),
            .separator(),
            item("Settings…", #selector(AppDelegate.showSettings), ",", target: target),
            .separator(),
            item("Hide catchbox", #selector(NSApplication.hide(_:)), "h", target: nil),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], target: nil),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:)), target: nil),
            .separator(),
            item("Quit catchbox", #selector(NSApplication.terminate(_:)), "q", target: nil),
        ]))

        main.addItem(submenu("Mailbox", [
            item("New Mailbox", #selector(AppDelegate.newMailbox), "n", target: target),
            .separator(),
            item("Copy Address", #selector(AppDelegate.copyAddress), "c", [.command, .shift], target: target),
            item("Copy Latest Code", #selector(AppDelegate.copyLatestCode), "k", [.command, .shift], target: target),
            item("Open Latest Link", #selector(AppDelegate.openLatestLink), "o", [.command, .shift], target: target),
            .separator(),
            item("All Mailboxes", #selector(AppDelegate.showAllMailboxes), "0", target: target),
        ]))

        main.addItem(submenu("Edit", [
            item("Undo", Selector(("undo:")), "z", target: nil),
            item("Redo", Selector(("redo:")), "z", [.command, .shift], target: nil),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x", target: nil),
            item("Copy", #selector(NSText.copy(_:)), "c", target: nil),
            item("Paste", #selector(NSText.paste(_:)), "v", target: nil),
            item("Select All", #selector(NSText.selectAll(_:)), "a", target: nil),
            .separator(),
            item("Filter Messages", #selector(AppDelegate.focusFilter), "f", target: target),
        ]))

        main.addItem(submenu("View", [
            item("Reload", #selector(AppDelegate.reloadInbox), "r", target: target),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control], target: nil),
        ]))

        let window = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m", target: nil),
            item("Zoom", #selector(NSWindow.performZoom(_:)), target: nil),
            item("Close", #selector(NSWindow.performClose(_:)), "w", target: nil),
            .separator(),
            item("Inbox", #selector(AppDelegate.showInbox), "1", target: target),
        ])
        main.addItem(window)
        NSApp.windowsMenu = window.submenu

        return main
    }

    private static func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let menu = NSMenu(title: title)
        items.forEach(menu.addItem)
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        return holder
    }

    private static func item(_ title: String, _ action: Selector, _ key: String = "",
                             _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject?) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = target
        return item
    }
}
