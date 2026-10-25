import Capacitor
import UIKit

/// The web view, with this target's own plugins registered.
///
/// Capacitor registers only the plugins npm installed (`packageClassList` in
/// capacitor.config.json, which `npx cap copy` rewrites), so a plugin written
/// in this target has to be handed to the bridge here or the page never sees
/// it. Live dictation shipped in 1.3 build 1 without this and quietly fell back
/// to recording and uploading.
class NightlinkBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeSpeechPlugin())
    }
}
