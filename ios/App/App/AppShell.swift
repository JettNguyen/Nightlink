import Capacitor
import UIKit

/// The window's root. On iOS 18 and later it is a UIKit tab bar controller with
/// the app's five tabs, so the bar is Apple's own: Liquid Glass, the system's
/// sizes and titles, and wherever the system puts it. On the iPhone Duo with its
/// clock down the side, that is a vertical bar on the same edge.
///
/// There is still one web view and one page history. It moves into whichever
/// tab is selected, and the web side decides where each tab goes, the same as
/// when it drew its own bar. Before iOS 18 the web view is the whole screen and
/// the web side keeps drawing its bar, because the plugin it checks for is
/// never registered.
class AppShellViewController: UIViewController {

    static let background = UIColor(red: 13.0 / 255.0, green: 13.0 / 255.0, blue: 17.0 / 255.0, alpha: 1.0)
    /// `--primary` in index.css.
    static let accent = UIColor(red: 201.0 / 255.0, green: 167.0 / 255.0, blue: 240.0 / 255.0, alpha: 1.0)

    /// In the order the web bar had them. Search stays a plain tab rather than a
    /// `UISearchTab`, which would move it to the end and expect a native search
    /// field; the page has its own.
    private static let tabs: [(id: String, title: String, symbol: String)] = [
        ("journal", "Journal", "book.fill"),
        ("feed", "Feed", "safari.fill"),
        ("search", "Search", "magnifyingglass"),
        ("activity", "Activity", "bell.fill"),
        ("profile", "Profile", "person.fill")
    ]

    let bridgeController = NightlinkBridgeViewController()
    private var tabController: UITabBarController?
    private var hosts: [String: UIViewController] = [:]
    private var barVisible = false

    var usesNativeTabs: Bool { tabController != nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background
        overrideUserInterfaceStyle = .dark

        if #available(iOS 18.0, *) {
            makeTabController()
        }
        // Read by the bridge as it loads, so the plugin is registered or not
        // before the page's first script runs.
        bridgeController.shell = self
        if #available(iOS 18.0, *), let controller = tabController,
           let host = hosts[controller.selectedTab?.identifier ?? Self.tabs[0].id] {
            move(bridgeController, into: host)
        } else {
            move(bridgeController, into: self)
        }
    }

    @available(iOS 18.0, *)
    private func makeTabController() {
        let tabs = Self.tabs.map { spec -> UITab in
            let host = TabHostViewController()
            hosts[spec.id] = host
            return UITab(title: spec.title, image: UIImage(systemName: spec.symbol), identifier: spec.id) { _ in host }
        }

        let controller = UITabBarController(tabs: tabs)
        controller.view.tintColor = Self.accent
        controller.delegate = self

        // Hidden until the web side says someone is signed in.
        controller.setTabBarHidden(true, animated: false)

        addChild(controller)
        controller.view.frame = view.bounds
        controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(controller.view)
        controller.didMove(toParent: self)
        tabController = controller
    }

    private func move(_ child: UIViewController, into parent: UIViewController) {
        guard child.parent !== parent else { return }
        if child.parent != nil {
            child.willMove(toParent: nil)
            child.view.removeFromSuperview()
            child.removeFromParent()
        }
        parent.addChild(child)
        child.view.frame = parent.view.bounds
        child.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        parent.view.addSubview(child.view)
        child.didMove(toParent: parent)
        setNeedsStatusBarAppearanceUpdate()
    }

    // MARK: - Driven by the web side

    /// Selects a tab without telling the web side, which asked for it.
    func selectTab(_ id: String) {
        guard #available(iOS 18.0, *), let controller = tabController else { return }
        guard let tab = controller.tab(forIdentifier: id), tab !== controller.selectedTab else { return }
        controller.selectedTab = tab
        if let host = hosts[id] { move(bridgeController, into: host) }
    }

    func setTabBarVisible(_ visible: Bool) {
        guard #available(iOS 18.0, *), let controller = tabController, visible != barVisible else { return }
        barVisible = visible
        controller.setTabBarHidden(!visible, animated: true)
    }

    func setBadges(_ badges: [String: String]) {
        guard #available(iOS 18.0, *), let controller = tabController else { return }
        for spec in Self.tabs {
            guard let tab = controller.tab(forIdentifier: spec.id) else { continue }
            let value = badges[spec.id].flatMap { $0.isEmpty ? nil : $0 }
            if tab.badgeValue != value { tab.badgeValue = value }
        }
    }

    // MARK: - System

    override var childForStatusBarStyle: UIViewController? { bridgeController }
    override var childForStatusBarHidden: UIViewController? { bridgeController }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        bridgeController.supportedInterfaceOrientations
    }
}

@available(iOS 18.0, *)
extension AppShellViewController: UITabBarControllerDelegate {
    func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        if tab === tabBarController.selectedTab {
            bridgeController.tabsPlugin?.notifySelect(tab.identifier, reselect: true)
        }
        return true
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?) {
        guard selectedTab !== previousTab else { return }
        if let host = hosts[selectedTab.identifier] { move(bridgeController, into: host) }
        bridgeController.tabsPlugin?.notifySelect(selectedTab.identifier, reselect: false)
    }
}

/// An empty tab. The web view is moved in while the tab is selected.
private final class TabHostViewController: UIViewController {
    override func loadView() {
        view = UIView()
        view.backgroundColor = AppShellViewController.background
    }
}

/// The web view, with this target's own plugins registered.
///
/// Capacitor registers only the plugins npm installed (`packageClassList` in
/// capacitor.config.json, which `npx cap copy` rewrites), so a plugin written
/// in this target has to be handed to the bridge here or the page never sees
/// it. Live dictation shipped in 1.3 build 1 without this and quietly fell back
/// to recording and uploading.
class NightlinkBridgeViewController: CAPBridgeViewController {
    weak var shell: AppShellViewController?
    private(set) var tabsPlugin: NativeTabsPlugin?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeSpeechPlugin())
        if let shell = shell, shell.usesNativeTabs {
            let plugin = NativeTabsPlugin()
            plugin.shell = shell
            bridge?.registerPluginInstance(plugin)
            tabsPlugin = plugin
        }
    }
}

/// Lets the page drive the native tabs: which one is selected, whether the bar
/// shows, and the counts on Feed and Activity. Taps come back as `select`
/// events, and the page does the navigating.
@objc(NativeTabsPlugin)
public class NativeTabsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeTabsPlugin"
    public let jsName = "NativeTabs"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise)
    ]

    weak var shell: AppShellViewController?

    /// Every field is optional: `selected` (a tab id), `visible`, and `badges`
    /// (tab id to text, empty for none).
    @objc func update(_ call: CAPPluginCall) {
        let selected = call.getString("selected")
        let visible = call.getBool("visible")
        let badges = call.getObject("badges")?.compactMapValues { $0 as? String }
        DispatchQueue.main.async {
            if let selected = selected { self.shell?.selectTab(selected) }
            if let badges = badges { self.shell?.setBadges(badges) }
            if let visible = visible { self.shell?.setTabBarVisible(visible) }
            call.resolve()
        }
    }

    func notifySelect(_ id: String, reselect: Bool) {
        notifyListeners("select", data: ["id": id, "reselect": reselect])
    }
}
