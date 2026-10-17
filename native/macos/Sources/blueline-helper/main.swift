// blueline-helper: Blueline's macOS native helper (SPEC 6.1 Becoming the default app, 9.6 native/, 9.9 Write
// protocol addition and Derived files keep the marker).
//
// A long-lived child of Blueline's main process. It reads one JSON request per line on stdin and writes one
// JSON reply per line on stdout, with the request's id (packages/app/src/main/native-helper.ts is the other
// end; README.md lists the operations). Replies can come out of order: setDefaultHtmlApp waits for the user's
// answer from macOS 26.4, while the attribute operations answer at once. When stdin closes (Blueline quit
// or crashed) the helper exits.
//
// Swift 5.9, macOS 12 or later, system frameworks only.

import AppKit
import CoreServices
import Darwin
import Foundation
import UniformTypeIdentifiers

let quarantineName = "com.apple.quarantine"
/** A marker is a short string (`flags;time;agent;uuid`); anything larger is refused, as main refuses it. */
let maxMarkerBytes = 64 * 1024
let maxLineBytes = 1024 * 1024

// MARK: - Replies

let outputLock = NSLock()

/// Writes all of `data` to stdout. If main is gone (EPIPE), there is nobody to answer: exit.
func writeAll(_ data: Data) {
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard var p = raw.baseAddress else { return }
        var left = raw.count
        while left > 0 {
            let n = Darwin.write(STDOUT_FILENO, p, left)
            if n < 0 {
                if errno == EINTR { continue }
                exit(0)
            }
            p = p.advanced(by: n)
            left -= n
        }
    }
}

func send(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          var data = try? JSONSerialization.data(withJSONObject: object, options: [])
    else { return }
    data.append(0x0A)
    outputLock.lock()
    writeAll(data)
    outputLock.unlock()
}

func ok(_ id: Int, _ fields: [String: Any] = [:]) {
    var o = fields
    o["id"] = id
    o["ok"] = true
    send(o)
}

func fail(_ id: Int, _ message: String, _ fields: [String: Any] = [:]) {
    var o = fields
    o["id"] = id
    o["ok"] = false
    o["error"] = message
    send(o)
}

func posixMessage(_ call: String, _ code: Int32) -> String {
    return "\(call): \(String(cString: strerror(code)))"
}

// MARK: - Arguments

/// An absolute path main sent: no NUL (a C string would end there), shorter than PATH_MAX.
func absolutePath(_ v: Any?) -> String? {
    guard let s = v as? String, s.hasPrefix("/"), !s.contains("\u{0}"), s.utf8.count < Int(PATH_MAX) else { return nil }
    return s
}

/// A quarantine value: non-empty text, no NUL or line break, at most maxMarkerBytes.
func markerValue(_ v: Any?) -> String? {
    guard let s = v as? String, !s.isEmpty, s.utf8.count <= maxMarkerBytes,
          !s.contains("\u{0}"), !s.contains("\n"), !s.contains("\r")
    else { return nil }
    return s
}

func optionalString(_ v: Any?) -> String? {
    guard let s = v as? String, !s.isEmpty, s.utf8.count <= 16 * 1024, !s.contains("\u{0}") else { return nil }
    return s
}

// MARK: - Quarantine (getxattr, setxattr, Launch Services)

enum QuarantineRead {
    case value(String)
    case none
    case failure(String)
}

/// The whole com.apple.quarantine value of `path` (6.10: what trust.json remembers a decision against).
func readQuarantine(_ path: String) -> QuarantineRead {
    for _ in 0..<3 {
        let size = getxattr(path, quarantineName, nil, 0, 0, 0)
        if size < 0 {
            let e = errno
            return e == ENOATTR ? .none : .failure(posixMessage("getxattr", e))
        }
        if size > maxMarkerBytes { return .failure("the quarantine attribute is too large") }
        var buffer = [UInt8](repeating: 0, count: max(size, 1))
        let read = getxattr(path, quarantineName, &buffer, buffer.count, 0, 0)
        if read < 0 {
            let e = errno
            if e == ERANGE { continue } // it grew between the two calls
            return e == ENOATTR ? .none : .failure(posixMessage("getxattr", e))
        }
        var bytes = Array(buffer[0..<read])
        while let last = bytes.last, last == 0 { bytes.removeLast() }
        guard let text = String(bytes: bytes, encoding: .utf8), !text.isEmpty else {
            return .failure("the quarantine attribute is not text")
        }
        return .value(text)
    }
    return .failure("the quarantine attribute kept changing")
}

func quarantineReply(_ path: String) -> Any {
    switch readQuarantine(path) {
    case .value(let v): return v
    default: return NSNull()
    }
}

/// Sets the whole value (a marker copied from the document a file is derived from, 9.9).
func writeQuarantine(_ path: String, _ value: String) -> String? {
    let bytes = Array(value.utf8)
    let rc = setxattr(path, quarantineName, bytes, bytes.count, 0, 0)
    return rc == 0 ? nil : posixMessage("setxattr", errno)
}

/// Sets new quarantine properties through Launch Services, which builds the value and records the event with
/// its origin (the deck) and data URL (a download), so the marker names the deck as its source (9.9).
func writeQuarantineProperties(_ path: String, agent: String, origin: String?, dataURL: String?) -> String? {
    var url = URL(fileURLWithPath: path)
    var props: [String: Any] = [
        kLSQuarantineAgentNameKey as String: agent,
        kLSQuarantineTypeKey as String: (dataURL != nil ? kLSQuarantineTypeWebDownload : kLSQuarantineTypeOtherDownload) as String,
    ]
    if let o = origin, let u = URL(string: o) { props[kLSQuarantineOriginURLKey as String] = u }
    if let d = dataURL, let u = URL(string: d) { props[kLSQuarantineDataURLKey as String] = u }
    var values = URLResourceValues()
    values.quarantineProperties = props
    do {
        try url.setResourceValues(values)
    } catch {
        return error.localizedDescription
    }
    return nil
}

// MARK: - Default HTML app (NSWorkspace, macOS 12)

func currentHtmlApp() -> URL? {
    return NSWorkspace.shared.urlForApplication(toOpen: UTType.html)
}

func sameFile(_ a: URL, _ b: URL) -> Bool {
    if a.resolvingSymlinksInPath().standardizedFileURL.path == b.resolvingSymlinksInPath().standardizedFileURL.path { return true }
    let ka = (try? a.resourceValues(forKeys: [.fileResourceIdentifierKey]))?.fileResourceIdentifier as? NSObject
    let kb = (try? b.resourceValues(forKeys: [.fileResourceIdentifierKey]))?.fileResourceIdentifier as? NSObject
    if let ka = ka, let kb = kb { return ka.isEqual(kb) }
    return false
}

func appName(_ url: URL) -> String {
    if let b = Bundle(url: url) {
        if let n = (b.localizedInfoDictionary?["CFBundleDisplayName"] ?? b.infoDictionary?["CFBundleDisplayName"]) as? String, !n.isEmpty { return n }
        if let n = b.infoDictionary?["CFBundleName"] as? String, !n.isEmpty { return n }
    }
    return url.deletingPathExtension().lastPathComponent
}

/// An .app bundle main named (Blueline.app when packaged).
func appBundle(_ v: Any?) -> URL? {
    guard let s = absolutePath(v), s.hasSuffix(".app") || s.hasSuffix(".app/") else { return nil }
    let url = URL(fileURLWithPath: s, isDirectory: true)
    guard FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Info.plist").path) else { return nil }
    return url
}

/// macOS 26.4 or later, where every file-type default change made through this API asks the user (6.1). The
/// Darwin kernel release is read too: a helper built with an older SDK may be told an older macOS version.
func defaultChangePrompts() -> Bool {
    if ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 26, minorVersion: 4, patchVersion: 0)) { return true }
    var u = utsname()
    guard uname(&u) == 0 else { return false }
    let release = withUnsafePointer(to: &u.release) { $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) } }
    let parts = release.split(separator: ".").compactMap { Int($0) }
    guard parts.count >= 2 else { return false }
    // Darwin 25 is macOS 26; its minor version follows macOS's.
    return parts[0] > 25 || (parts[0] == 25 && parts[1] >= 4)
}

func setDefaultHtmlApp(_ id: Int, _ app: URL) {
    NSWorkspace.shared.setDefaultApplication(at: app, toOpen: UTType.html) { error in
        guard let error = error else {
            ok(id)
            return
        }
        // Changed after all (for example by the user in Finder meanwhile): report what is true now.
        if let now = currentHtmlApp(), sameFile(now, app) {
            ok(id)
            return
        }
        let ns = error as NSError
        let cancelled = (ns.domain == NSCocoaErrorDomain && ns.code == NSUserCancelledError)
            || (ns.domain == NSOSStatusErrorDomain && ns.code == Int(userCanceledErr))
        // From macOS 26.4 the system asks (Use or Keep) and a Keep comes back as an error; Apple documents no
        // code for it, so on those versions any refusal counts as "not now" (6.0 First run).
        fail(id, ns.localizedDescription, ["declined": cancelled || defaultChangePrompts(), "domain": ns.domain, "code": ns.code])
    }
}

// MARK: - Requests

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data, options: []),
          let req = obj as? [String: Any],
          let id = req["id"] as? Int
    else { return } // no id: nothing can be answered
    let op = req["op"] as? String ?? ""
    switch op {
    case "readQuarantine":
        guard let path = absolutePath(req["path"]) else { return fail(id, "path must be absolute") }
        switch readQuarantine(path) {
        case .value(let v): ok(id, ["value": v])
        case .none: ok(id, ["value": NSNull()])
        case .failure(let m): fail(id, m)
        }

    case "copyXattrs":
        // 9.9 Write protocol addition: copyfile(deck, temp, NULL, COPYFILE_XATTR), every extended attribute.
        guard let from = absolutePath(req["from"]), let to = absolutePath(req["to"]) else { return fail(id, "paths must be absolute") }
        if copyfile(from, to, nil, copyfile_flags_t(COPYFILE_XATTR)) != 0 { return fail(id, posixMessage("copyfile", errno)) }
        ok(id)

    case "setQuarantine":
        guard let path = absolutePath(req["path"]) else { return fail(id, "path must be absolute") }
        if req["value"] != nil {
            guard let value = markerValue(req["value"]) else { return fail(id, "not a quarantine value") }
            if let e = writeQuarantine(path, value) { return fail(id, e) }
        } else if let props = req["properties"] as? [String: Any] {
            let agent = optionalString(props["agent"]) ?? "Blueline"
            if let e = writeQuarantineProperties(path, agent: agent, origin: optionalString(props["originUrl"]), dataURL: optionalString(props["dataUrl"])) {
                return fail(id, e)
            }
        } else {
            return fail(id, "value or properties required")
        }
        ok(id, ["value": quarantineReply(path)])

    case "isDefaultHtmlApp":
        let app = appBundle(req["app"])
        // NSWorkspace is AppKit: ask on the main queue (dispatchMain below serves it).
        DispatchQueue.main.async {
            var fields: [String: Any] = ["isDefault": false, "current": NSNull(), "currentName": NSNull()]
            if let c = currentHtmlApp() {
                fields["current"] = c.path
                fields["currentName"] = appName(c)
                if let app = app { fields["isDefault"] = sameFile(c, app) }
            }
            ok(id, fields)
        }

    case "setDefaultHtmlApp":
        guard let app = appBundle(req["app"]) else { return fail(id, "not an application bundle") }
        DispatchQueue.main.async { setDefaultHtmlApp(id, app) }

    default:
        fail(id, "unknown operation")
    }
}

// MARK: - Main

// A write to a closed pipe returns EPIPE (handled in writeAll) instead of killing the helper mid-reply.
signal(SIGPIPE, SIG_IGN)

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        if line.utf8.count > maxLineBytes { continue }
        handle(line)
    }
    // stdin closed: Blueline quit or crashed. Exit after the main queue's work already queued (a reply to a
    // request read just before the end); nobody waits for a default-app answer still pending.
    DispatchQueue.main.async { exit(0) }
}
reader.start()
// The main queue runs the NSWorkspace calls and keeps the process alive for their completion handlers.
dispatchMain()
