import Foundation

/// A loopback port nobody is using right now.
///
/// The app runs its own server instead of sharing `catchbox ui` on 7337: the two may be
/// different versions, and quitting one must never take the other's inbox away. The port
/// has to be known up front, because the server checks the Origin of every request
/// against the port it was started on.
public func freeLoopbackPort() -> UInt16? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }

    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    addr.sin_port = 0
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0 else { return nil }

    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
    }
    guard named == 0 else { return nil }
    return UInt16(bigEndian: addr.sin_port)
}
