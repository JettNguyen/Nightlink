import AVFoundation
import Capacitor
import Foundation
import Speech

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
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    private var listening = false
    private var transcript = ""
    private var lastLevelAt: TimeInterval = 0
    private var interruptionObserver: NSObjectProtocol?

    /// `stop()` resolves with the final transcript, which arrives a beat after
    /// the audio ends, so the call is held until the recogniser settles.
    private var pendingStop: CAPPluginCall?
    private var stopWatchdog: DispatchWorkItem?

    /// How long to wait for the recogniser's last word after the audio stops
    /// before answering with whatever the last partial held.
    private static let finalResultTimeout: TimeInterval = 3.0
    /// ~25 level events a second is enough for a smooth meter without flooding
    /// the bridge.
    private static let levelInterval: TimeInterval = 0.04

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
            self.transcript = ""
            self.lastLevelAt = 0

            self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self = self else { return }

                if let result = result {
                    let text = result.bestTranscription.formattedString
                    DispatchQueue.main.async {
                        self.transcript = text
                        self.notifyListeners("partialResult", data: ["text": text])
                        if result.isFinal {
                            self.finish(with: text)
                        }
                    }
                    return
                }

                if let error = error {
                    DispatchQueue.main.async {
                        // A cancelled task and "no speech detected" both surface
                        // as errors even though neither is a failure the user
                        // needs to see, so settle with whatever was heard.
                        if self.isBenign(error) {
                            self.finish(with: self.transcript)
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
            self.observeInterruptions()
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
            if self.transcript.isEmpty {
                self.failListening("Recording was interrupted.")
            } else {
                self.finish(with: self.transcript)
            }
        }
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
            guard self.listening else {
                call.resolve(["text": self.transcript])
                return
            }

            self.pendingStop = call
            self.audioEngine.inputNode.removeTap(onBus: 0)
            self.audioEngine.stop()
            self.request?.endAudio()

            let watchdog = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                self.finish(with: self.transcript)
            }
            self.stopWatchdog = watchdog
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.finalResultTimeout, execute: watchdog)
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.pendingStop?.resolve(["text": ""])
            self.pendingStop = nil
            self.transcript = ""
            self.teardown()
            call.resolve()
        }
    }

    // MARK: - Settling

    private func finish(with text: String) {
        guard listening || pendingStop != nil else { return }
        let call = pendingStop
        pendingStop = nil
        teardown()
        notifyListeners("finalResult", data: ["text": text])
        call?.resolve(["text": text])
    }

    private func failListening(_ message: String) {
        let call = pendingStop
        pendingStop = nil
        let heard = transcript
        teardown()
        notifyListeners("error", data: ["message": message])
        // A stop() that is already in flight still gets an answer, otherwise the
        // JS side would hang on an unresolved promise.
        if let call = call {
            call.resolve(["text": heard])
        }
    }

    private func teardown() {
        stopWatchdog?.cancel()
        stopWatchdog = nil

        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }

        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }

        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        listening = false

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
        return "Dictation stopped unexpectedly. Please try again."
    }

    deinit {
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}
