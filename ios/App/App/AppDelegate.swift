import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        enableWebViewBounceIfNeeded()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Only called on true background → foreground transitions (not interruptions
        // or system overlays). Safe to re-apply webview appearance here without
        // risk of triggering during in-app navigation.
        enableWebViewBounceIfNeeded()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Do NOT call enableWebViewBounceIfNeeded here — this fires for any
        // interruption (system alerts, iOS 26 Liquid Glass overlays, etc.) and
        // the 0.35 s delayed timer was causing a blank-box flash on in-app navigation.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    private func enableWebViewBounceIfNeeded() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            guard let bridgeVC = self.findBridgeViewController() else { return }
            guard let webView = bridgeVC.bridge?.webView else { return }

            let appBg = UIColor(red: 5.0/255.0, green: 7.0/255.0, blue: 15.0/255.0, alpha: 1.0)

            // Mark the WebView as opaque so iOS 26 Liquid Glass doesn't composite
            // its tint layer over the app content.
            webView.isOpaque = true
            webView.backgroundColor = appBg
            webView.scrollView.backgroundColor = appBg
            bridgeVC.view.backgroundColor = appBg

            // underPageBackgroundColor prevents the system pull-to-refresh rubberbanding
            // area from showing the iOS system background colour (iOS 15+).
            if #available(iOS 15.0, *) {
                webView.underPageBackgroundColor = appBg
            }

            webView.scrollView.bounces = true
            webView.scrollView.alwaysBounceVertical = true
            webView.scrollView.alwaysBounceHorizontal = false

            // The web view's scroll indicator is the one scrollbar CSS cannot
            // reach — it belongs to the underlying UIScrollView. A real iOS
            // screen doesn't park a bar down its right edge, and leaving it on
            // was what made scrolling read as a web page. Bouncing stays, so
            // the top and bottom of a list are still felt rather than seen.
            webView.scrollView.showsVerticalScrollIndicator = false
            webView.scrollView.showsHorizontalScrollIndicator = false

            // Enable native iOS swipe-to-go-back gesture.
            // React Router uses history.pushState so WKWebView tracks those entries;
            // swiping back fires a popstate event that React Router responds to.
            webView.allowsBackForwardNavigationGestures = true
        }
    }

    private func findBridgeViewController() -> CAPBridgeViewController? {
        let roots = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .compactMap { $0.rootViewController }

        var queue = roots
        var visited = Set<ObjectIdentifier>()

        while !queue.isEmpty {
            let current = queue.removeFirst()
            let id = ObjectIdentifier(current)
            if visited.contains(id) { continue }
            visited.insert(id)

            if let bridgeVC = current as? CAPBridgeViewController {
                return bridgeVC
            }

            queue.append(contentsOf: current.children)
            if let presented = current.presentedViewController {
                queue.append(presented)
            }
        }

        return nil
    }

}
