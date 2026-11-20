import AVFoundation
import Capacitor
import Foundation
import Speech
import UIKit

/// Live dictation backed by Apple's Speech framework.
///
/// The web build records audio and posts it to `/api/transcribe`, which cannot
/// show anything until the user stops talking. `SFSpeechRecognizer` streams
/// partial results instead, so words land in the UI as they are spoken, costs
/// nothing per use, and when the locale has an on-device model it never sends
/// audio off the phone.
///
/// This is written as a local plugin rather than pulling in
/// `@capacitor-community/speech-recognition` because that package ships only a
/// podspec, and this project is Swift Package Manager with no Podfile.
@objc(NativeSpeechPlugin)
public class NativeSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeSpeechPlugin"
    public let jsName = "NativeSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestSpeechPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise)
    ]

    /// Why a recording ended, sent with `finalResult` so the page can explain a
    /// stop the user did not ask for.
    private enum EndReason: String {
        /// The page called `stop()`.
        case stopped
        /// Nightlink left the screen, and iOS takes the mic from an app in the
        /// background.
        case background
        /// A call, Siri or an alarm took the audio.
        case interrupted
        /// The recogniser closed the request on its own, or the safety limit hit.
        case ended
    }

    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    private var listening = false
    private var stitcher = TranscriptStitcher()
    private var transcript: String { stitcher.text }
    private var lastLevelAt: TimeInterval = 0
    private var interruptionObserver: NSObjectProtocol?
    private var backgroundObserver: NSObjectProtocol?
    /// Bumped on every start, so a late callback from an earlier recognition
    /// task cannot write into the next recording.
    private var session = 0

    /// Set once the audio has been ended, by `stop()` or by the app leaving the
    /// screen, while the recogniser settles its last words.
    private var endReason: EndReason?
    /// `stop()` resolves with the final transcript, which arrives a beat after
    /// the audio ends, so the call is held until the recogniser settles.
    private var pendingStop: CAPPluginCall?
    private var stopWatchdog: DispatchWorkItem?
    private var limitTimer: DispatchWorkItem?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    /// How long to wait for the recogniser's last word after the audio stops
    /// before answering with whatever the last partial held.
    private static let finalResultTimeout: TimeInterval = 3.0
    /// ~25 level events a second is enough for a smooth meter without flooding
    /// the bridge.
    private static let levelInterval: TimeInterval = 0.04
    /// The page stops a recording at one minute. This is the backstop for a page
    /// that never gets to, such as one that reloaded mid-recording, so the mic
    /// and the kept-awake screen are never left on.
    private static let maxListeningTime: TimeInterval = 75

    // MARK: - Capability

    private func makeRecognizer() -> SFSpeechRecognizer? {
        if let localeMatch = SFSpeechRecognizer(locale: Locale.current), localeMatch.isAvailable {
            return localeMatch
        }
        return SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    @objc func available(_ call: CAPPluginCall) {
        let recognizer = makeRecognizer()
        let speechStatus = SFSpeechRecognizer.authorizationStatus()

        call.resolve([
            "available": recognizer?.isAvailable ?? false,
            "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
            "locale": recognizer?.locale.identifier ?? "",
            "speechPermission": authorizationName(speechStatus),
            "micPermission": microphonePermissionName()
        ])
    }

    private func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    private func microphonePermissionName() -> String {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: return "granted"
            case .denied: return "denied"
            case .undetermined: return "prompt"
            @unknown default: return "prompt"
            }
        }
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        case .undetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    // MARK: - Permissions

    // Named apart from CAPPlugin's own `requestPermissions`, which this would
    // otherwise have to override with matching access and semantics.
    @objc func requestSpeechPermissions(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
            guard let self = self else { return }
            self.requestMicrophone { micGranted in
                DispatchQueue.main.async {
                    call.resolve([
                        "speechPermission": self.authorizationName(speechStatus),
                        "micPermission": micGranted ? "granted" : "denied"
                    ])
                }
            }
        }
    }

    private func requestMicrophone(_ completion: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: completion)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(completion)
        }
    }

    // MARK: - Start

    @objc func start(_ call: CAPPluginCall) {
        let preferOnDevice = call.getBool("onDevice", true)

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            if self.listening {
                call.reject("Already listening.", "busy")
                return
            }

            guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
                call.reject("Speech recognition permission was not granted.", "permission")
                return
            }

            guard let recognizer = self.makeRecognizer(), recognizer.isAvailable else {
                call.reject("Speech recognition is unavailable right now.", "unavailable")
                return
            }

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            // Keep audio on the phone when the locale has a downloaded model.
            // Without this, Apple streams it to their servers for recognition.
            let onDevice = preferOnDevice && recognizer.supportsOnDeviceRecognition
            request.requiresOnDeviceRecognition = onDevice
            if #available(iOS 16.0, *) {
                request.addsPunctuation = true
            }

            do {
                try self.beginAudioSession()
            } catch {
                self.teardown()
                call.reject("Could not access the microphone.", "audio")
                return
            }

            self.recognizer = recognizer
            self.request = request
            self.stitcher.reset()
            self.endReason = nil
            self.lastLevelAt = 0
            self.session += 1
            let session = self.session

            self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self = self else { return }

                if let result = result {
                    let text = result.bestTranscription.formattedString
                    let closesUtterance = result.speechRecognitionMetadata != nil
                    let isFinal = result.isFinal
                    DispatchQueue.main.async {
                        guard self.session == session, self.listening else { return }
                        self.stitcher.absorb(text, closesUtterance: closesUtterance)
                        self.notifyListeners("partialResult", data: ["text": self.transcript])
                        if isFinal {
                            self.finish(with: self.transcript, reason: self.endReason ?? .ended)
                        }
                    }
                    return
                }

                if let error = error {
                    DispatchQueue.main.async {
                        guard self.session == session else { return }
                        // A cancelled task and "no speech detected" both surface
                        // as errors even though neither is a failure the user
                        // needs to see, so settle with whatever was heard.
                        if self.isBenign(error) {
                            self.finish(with: self.transcript, reason: self.endReason ?? .ended)
                        } else {
                            self.failListening(self.friendlyMessage(for: error))
                        }
                    }
                }
            }

            let input = self.audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)

            guard format.sampleRate > 0 else {
                self.teardown()
                call.reject("The microphone is busy in another app.", "audio")
                return
            }

            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let self = self else { return }
                self.request?.append(buffer)
                self.emitLevel(from: buffer)
            }

            self.audioEngine.prepare()
            do {
                try self.audioEngine.start()
            } catch {
                self.teardown()
                call.reject("Could not start listening.", "audio")
                return
            }

            self.listening = true
            // Auto-lock would otherwise put the phone to sleep partway through
            // someone describing a dream, and a sleeping app loses the mic.
            UIApplication.shared.isIdleTimerDisabled = true
            self.observeInterruptions()
            self.observeBackground()
            self.scheduleLimit()
            call.resolve([
                "onDevice": onDevice,
                "locale": recognizer.locale.identifier
            ])
        }
    }

    private func beginAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    /// A phone call or Siri takes the audio route out from under the engine, and
    /// without this the UI would sit there showing a live meter that has frozen.
    private func observeInterruptions() {
        guard interruptionObserver == nil else { return }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard let self = self, self.listening else { return }
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            // iOS also reports an interruption when it takes the mic from an app
            // that went to the background, which is not a call.
            let inBackground = UIApplication.shared.applicationState == .background
            let reason = self.endReason ?? (inBackground ? .background : .interrupted)
            if self.transcript.isEmpty && reason == .interrupted {
                self.failListening("Recording stopped for a call or alert. Tap the mic to try again.")
            } else {
                self.finish(with: self.transcript, reason: reason)
            }
        }
    }

    /// Without the audio background mode, iOS cuts the mic off once Nightlink
    /// leaves the screen. Left running, the recording would pick back up on
    /// return after a long silence, which the recogniser takes as a fresh start.
    /// So the recording ends here instead, and keeps every word heard so far.
    private func observeBackground() {
        guard backgroundObserver == nil else { return }
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self, self.listening else { return }
            self.holdBackgroundTime()
            self.endAudio(.background)
        }
    }

    /// Asks iOS for a few seconds in the background so the recogniser can hand
    /// back the last words before the app is suspended.
    private func holdBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish dictation") { [weak self] in
            guard let self = self else { return }
            self.finish(with: self.transcript, reason: .background)
            self.releaseBackgroundTime()
        }
    }

    private func releaseBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func scheduleLimit() {
        limitTimer?.cancel()
        let limit = DispatchWorkItem { [weak self] in
            guard let self = self, self.listening else { return }
            self.endAudio(.ended)
        }
        limitTimer = limit
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.maxListeningTime, execute: limit)
    }

    // MARK: - Level metering

    private func emitLevel(from buffer: AVAudioPCMBuffer) {
        let now = Date.timeIntervalSinceReferenceDate
        guard now - lastLevelAt >= Self.levelInterval else { return }
        lastLevelAt = now

        guard let channel = buffer.floatChannelData?[0] else { return }
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return }

        var sum: Float = 0
        for i in 0..<frames {
            let sample = channel[i]
            sum += sample * sample
        }

        // RMS maps to a tiny slice of 0...1 linearly, so convert to decibels and
        // stretch the top 50 dB across the meter, since that is the range speech
        // actually moves through.
        let rms = sqrtf(sum / Float(frames))
        let decibels = 20 * log10f(max(rms, 1e-7))
        let level = max(0, min(1, (decibels + 50) / 50))

        notifyListeners("level", data: ["level": Double(level)])
    }

    // MARK: - Stop / cancel

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // Already over, for instance because the app went to the background.
            // The words are kept until the next start, so hand them back.
            guard self.listening else {
                call.resolve(["text": self.transcript])
                return
            }

            // A second stop while the first is settling would otherwise leave the
            // first promise hanging.
            self.pendingStop?.resolve(["text": self.transcript])
            self.pendingStop = call
            self.endAudio(.stopped)
        }
    }

    /// Stops feeding the recogniser and gives it a moment to settle the last
    /// words. Whichever comes first, the final result or the watchdog, ends it.
    private func endAudio(_ reason: EndReason) {
        guard endReason == nil else { return }
        endReason = reason
        limitTimer?.cancel()
        limitTimer = nil
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        request?.endAudio()

        let watchdog = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.finish(with: self.transcript, reason: self.endReason ?? reason)
        }
        stopWatchdog = watchdog
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.finalResultTimeout, execute: watchdog)
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.pendingStop?.resolve(["text": ""])
            self.pendingStop = nil
            self.stitcher.reset()
            self.teardown()
            call.resolve()
        }
    }

    /// Holds the screen on for the record-and-upload fallback, which has no
    /// native session of its own to do it. The live engine handles this itself.
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on", true)
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }

    // MARK: - Settling

    /// Every ending goes out as a `finalResult` event, because the page is not
    /// always the one that asked: the app may have left the screen, or a call
    /// may have come in. A `stop()` that asked gets the same answer.
    private func finish(with text: String, reason: EndReason) {
        guard listening || pendingStop != nil else { return }
        let call = pendingStop
        pendingStop = nil
        teardown()
        notifyListeners("finalResult", data: ["text": text, "reason": reason.rawValue])
        call?.resolve(["text": text, "reason": reason.rawValue])
    }

    private func failListening(_ message: String) {
        guard listening || pendingStop != nil else { return }
        // Never throw away words the user already said over a fault partway
        // through. They land in the entry, and the page says it stopped early.
        if !transcript.isEmpty {
            finish(with: transcript, reason: endReason ?? .ended)
            return
        }
        let call = pendingStop
        pendingStop = nil
        teardown()
        notifyListeners("error", data: ["message": message])
        // A stop() that is already in flight still gets an answer, otherwise the
        // JS side would hang on an unresolved promise.
        call?.resolve(["text": ""])
    }

    private func teardown() {
        stopWatchdog?.cancel()
        stopWatchdog = nil
        limitTimer?.cancel()
        limitTimer = nil

        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }
        if let observer = backgroundObserver {
            NotificationCenter.default.removeObserver(observer)
            backgroundObserver = nil
        }

        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }

        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        if listening {
            UIApplication.shared.isIdleTimerDisabled = false
        }
        listening = false
        endReason = nil

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        releaseBackgroundTime()
    }

    // MARK: - Error shaping

    private func isBenign(_ error: Error) -> Bool {
        let nsError = error as NSError
        // 216/301 are the recogniser being cancelled, 203 is "retry" which is
        // what a silent recording reports, 1110 is no speech detected.
        return [203, 216, 301, 1110].contains(nsError.code)
    }

    private func friendlyMessage(for error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            return "Dictation needs a connection for this language. Try again on Wi-Fi."
        }
        return "Dictation stopped unexpectedly. Tap the mic to try again."
    }

    deinit {
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = backgroundObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}

// MARK: - Stitching utterances

/// Builds one transcript out of the recogniser's utterances.
///
/// Since iOS 18, `SFSpeechRecognizer` starts a new utterance after a pause, and
/// `bestTranscription` then holds only the words said since that pause. Taken
/// as the whole transcript, a long pause wiped out everything said before it,
/// which is what happened when the phone slept partway through a recording.
/// This keeps each finished utterance and adds the newest one on the end.
///
/// The recogniser also revises its partials as it hears more, so a partial
/// that changed is not by itself a new utterance. It counts as one when the
/// recogniser flagged the last utterance as finished and the new text does not
/// carry on from it, or when the text drops by two or more words, which a
/// revision almost never does and a fresh start always does.
struct TranscriptStitcher {
    private(set) var committed = ""
    private(set) var utterance = ""
    private var utteranceClosed = false

    var text: String { Self.join(committed, utterance) }

    mutating func reset() {
        committed = ""
        utterance = ""
        utteranceClosed = false
    }

    mutating func absorb(_ partial: String, closesUtterance: Bool) {
        let next = Self.words(partial)
        let earlier = Self.words(committed)
        if earlier.count >= 3 && Self.carriesOn(next, from: earlier, share: 0.9) {
            // The recogniser sent the earlier utterances again along with the
            // new one, so there is nothing left to stitch.
            committed = ""
        } else if !utterance.isEmpty && startsNewUtterance(next) {
            committed = Self.join(committed, utterance)
        }
        utterance = partial
        utteranceClosed = closesUtterance
    }

    private func startsNewUtterance(_ next: [String]) -> Bool {
        let previous = Self.words(utterance)
        // Some iOS versions flag an utterance as finished and then keep
        // extending it, so the flag alone is not enough.
        if utteranceClosed { return !Self.carriesOn(next, from: previous, share: 0.6) }
        return next.count + 2 <= previous.count
    }

    /// Whether `next` starts with `previous`, allowing for revised words.
    static func carriesOn(_ next: [String], from previous: [String], share: Double) -> Bool {
        guard !previous.isEmpty, next.count >= previous.count else { return false }
        let matched = zip(previous, next).filter { $0 == $1 }.count
        return Double(matched) >= Double(previous.count) * share
    }

    static func words(_ text: String) -> [String] {
        text.lowercased()
            .components(separatedBy: .whitespacesAndNewlines)
            .map { $0.trimmingCharacters(in: .punctuationCharacters) }
            .filter { !$0.isEmpty }
    }

    /// A new utterance comes back capitalized as a new sentence, so the one
    /// before it gets a period to match when the recogniser left it without one.
    static func join(_ head: String, _ tail: String) -> String {
        let head = head.trimmingCharacters(in: .whitespacesAndNewlines)
        let tail = tail.trimmingCharacters(in: .whitespacesAndNewlines)
        if head.isEmpty { return tail }
        if tail.isEmpty { return head }
        let ended = head.last.map { ".!?,;:".contains($0) } ?? true
        let capitalized = tail.first?.isUppercase ?? false
        return head + (ended || !capitalized ? " " : ". ") + tail
    }
}
