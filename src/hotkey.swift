import AppKit
import Foundation

let inbox = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if inbox.isEmpty {
    fputs("missing inbox path\n", stderr)
    exit(1)
}

let mask: NSEvent.ModifierFlags = [.control, .option]
guard let monitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { event in
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let pressed = flags.contains(.control) && flags.contains(.option) && !flags.contains(.command) && !flags.contains(.shift)
    if event.keyCode == 16 && pressed {
        let line = "{\"type\":\"listen\"}\n"
        if let data = line.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: inbox), let handle = FileHandle(forWritingAtPath: inbox) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: URL(fileURLWithPath: inbox))
            }
        }
    }
}) else {
    fputs("hotkey needs accessibility permission\n", stderr)
    exit(2)
}
_ = monitor
_ = mask
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
